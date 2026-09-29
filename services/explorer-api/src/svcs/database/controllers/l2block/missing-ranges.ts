import {
  type L2BlockRangeRequestEvent,
  type L2BlockRangeRequestReason,
} from "@chicmoz-pkg/message-registry";
import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  L2_BLOCK_RECONCILIATION_INTERVAL_MS,
  L2_BLOCK_RECONCILIATION_MAX_BLOCKS,
  L2_BLOCK_RECONCILIATION_MAX_RANGES,
  L2_BLOCK_RECONCILIATION_SCAN_WINDOW,
  L2_BLOCK_RECONCILIATION_TIP_REPAIR_WINDOW,
  L2_NETWORK_ID,
} from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import { l2OpenGapTable } from "../../schema/l2/open-gap.js";
import { l2Block } from "../../schema/l2block/index.js";
import { getCurrentRollupVersionNumber } from "../l2/chain-info/rollup-version-cache.js";
import { getTips } from "../l2/tips.js";
import { getLatestBlockRollupVersion, getLatestHeight } from "./get-latest.js";

type GapRange = { from: number; to: number; statusHint: "proposed" };
type OpenGap = typeof l2OpenGapTable.$inferSelect;

export type PlannedRangeRequest = {
  request: L2BlockRangeRequestEvent;
  // Records the request against its gaps. Call it only once the request is
  // published, so a failed publish is simply retried on the next tick.
  markRequested: () => Promise<void>;
};

export const rangesFromHeights = (missingHeights: number[]) => {
  const ranges: GapRange[] = [];
  for (const height of missingHeights) {
    const last = ranges[ranges.length - 1];
    if (last && last.to + 1 === height) {
      last.to = height;
    } else {
      ranges.push({ from: height, to: height, statusHint: "proposed" });
    }
  }
  return ranges;
};

/**
 * Gap rows are contiguous runs of at most this many heights: any row is then
 * one range, and a full request of such rows fits the block budget, so a row
 * is always requested whole or not at all.
 */
export const gapRowMaxWidth = (maxBlocks: number, maxRanges: number) =>
  Math.max(1, Math.floor(maxBlocks / maxRanges));

export const splitRange = (range: GapRange, maxWidth: number): GapRange[] => {
  const chunks: GapRange[] = [];
  for (let from = range.from; from <= range.to; from += maxWidth) {
    chunks.push({ ...range, from, to: Math.min(range.to, from + maxWidth - 1) });
  }
  return chunks;
};

const gapId = ({
  from,
  to,
  reason,
}: {
  from: number;
  to: number;
  reason: L2BlockRangeRequestReason;
}) => `${L2_NETWORK_ID}:${reason}:${from}:${to}`;

const upsertOpenGaps = async ({
  ranges,
  reason,
  resetOnReopen = true,
  executor = db(),
}: {
  ranges: GapRange[];
  reason: L2BlockRangeRequestReason;
  resetOnReopen?: boolean;
  executor?: ReturnType<typeof db>;
}) => {
  for (const range of ranges) {
    const values = {
      id: gapId({ ...range, reason }),
      l2NetworkId: L2_NETWORK_ID,
      fromHeight: range.from,
      toHeight: range.to,
      reason,
      statusHint: range.statusHint,
      status: "open" as const,
      lastSeenAt: new Date(),
      fulfilledAt: null,
      lastError: null,
    };

    await executor
      .insert(l2OpenGapTable)
      .values(values)
      .onConflictDoUpdate({
        target: l2OpenGapTable.id,
        set: {
          status: "open",
          lastSeenAt: values.lastSeenAt,
          statusHint: values.statusHint,
          fulfilledAt: null,
          lastError: null,
          // A row reopened after being fulfilled is a new gap: its earlier
          // requests say nothing about it, so its backoff starts over.
          ...(resetOnReopen
            ? {
                requestCount: sql`case when ${l2OpenGapTable.status} = 'fulfilled' then 0 else ${l2OpenGapTable.requestCount} end`,
                lastRequestedAt: sql`case when ${l2OpenGapTable.status} = 'fulfilled' then null else ${l2OpenGapTable.lastRequestedAt} end`,
              }
            : {}),
        },
      });
  }
};

// Backoff after a gap's Nth request: interval * 2^min(N, 8), capped at 1h.
// 2^8 intervals already exceeds the cap; the exponent cap only keeps the
// arithmetic small. The cap is short because the listener drops requests
// without telling anyone (a busy queue, a node error), and a dropped request
// still backs its gaps off.
const MAX_BACKOFF_EXPONENT = 8;
const MAX_GAP_BACKOFF_MS = 60 * 60 * 1000;
// Due gaps considered per tick, after the due filter, least recently
// requested first.
const CANDIDATE_GAP_LIMIT = 50;
const TIP_BOUNDARY_REASON: L2BlockRangeRequestReason = "tip_boundary_mismatch";

/**
 * Whether a gap may be requested again at `now` (epoch ms): never requested,
 * or its backoff has passed. In SQL so the candidate query can filter on it
 * before ORDER BY and LIMIT. last_requested_at is stored as UTC wall-clock
 * time (drizzle writes toISOString()), so its epoch is taken as UTC.
 */
export const gapDueSql = (now: number) =>
  sql`(${l2OpenGapTable.lastRequestedAt} is null or extract(epoch from ${l2OpenGapTable.lastRequestedAt}) * 1000 + least(${L2_BLOCK_RECONCILIATION_INTERVAL_MS}::float8 * power(2, least(${l2OpenGapTable.requestCount}, ${MAX_BACKOFF_EXPONENT}::int)), ${MAX_GAP_BACKOFF_MS}::float8) <= ${now}::float8)`;

// Gaps the cadence and startup requests may pick. They ignore tip-boundary
// rows entirely; buildTipBoundaryRepairRequest owns those.
export const requestableGapFilter = (chainTip: number, now: number) =>
  and(
    eq(l2OpenGapTable.l2NetworkId, L2_NETWORK_ID),
    eq(l2OpenGapTable.status, "open"),
    ne(l2OpenGapTable.reason, TIP_BOUNDARY_REASON),
    lte(l2OpenGapTable.fromHeight, chainTip),
    gapDueSql(now),
  );

const getDueGaps = async (chainTip: number, now: number) =>
  db()
    .select()
    .from(l2OpenGapTable)
    .where(requestableGapFilter(chainTip, now))
    .orderBy(
      sql`${l2OpenGapTable.lastRequestedAt} asc nulls first`,
      asc(l2OpenGapTable.firstSeenAt),
    )
    .limit(CANDIDATE_GAP_LIMIT);

// Open cadence/startup gaps overlapping [from, to]: all of them for discovery
// (heights they cover are already recorded), or only those still in backoff
// (their heights are in flight).
const getOpenGapsOverlapping = async (
  from: number,
  to: number,
  { inFlightAt }: { inFlightAt?: number } = {},
) =>
  db()
    .select()
    .from(l2OpenGapTable)
    .where(
      and(
        eq(l2OpenGapTable.l2NetworkId, L2_NETWORK_ID),
        eq(l2OpenGapTable.status, "open"),
        ne(l2OpenGapTable.reason, TIP_BOUNDARY_REASON),
        lte(l2OpenGapTable.fromHeight, to),
        gte(l2OpenGapTable.toHeight, from),
        ...(inFlightAt === undefined ? [] : [not(gapDueSql(inFlightAt))]),
      ),
    );

/**
 * Whether a height lies in any of the gaps. The intervals are sorted and
 * merged once, then each lookup is a binary search, instead of scanning every
 * gap for every height.
 */
export const coverageOf = (
  gaps: Array<Pick<OpenGap, "fromHeight" | "toHeight">>,
) => {
  const merged: Array<{ from: number; to: number }> = [];
  const sorted = [...gaps].sort((a, b) => a.fromHeight - b.fromHeight);
  for (const { fromHeight, toHeight } of sorted) {
    const last = merged[merged.length - 1];
    if (last && fromHeight <= last.to + 1) {
      last.to = Math.max(last.to, toHeight);
    } else {
      merged.push({ from: fromHeight, to: toHeight });
    }
  }
  return (height: number) => {
    let low = 0;
    let high = merged.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (height < merged[middle].from) {
        high = middle - 1;
      } else if (height > merged[middle].to) {
        low = middle + 1;
      } else {
        return true;
      }
    }
    return false;
  };
};

const fulfilGaps = async (gapIds: string[]) => {
  if (gapIds.length === 0) {
    return;
  }
  await db()
    .update(l2OpenGapTable)
    .set({ status: "fulfilled", fulfilledAt: new Date(), lastError: null })
    .where(inArray(l2OpenGapTable.id, gapIds));
};

/**
 * Moves due rows that could not be requested this tick (their heights are
 * in flight, or present up to a tip they extend past) to the back of the
 * queue, so they do not hold the candidate window. The request count, and
 * so the backoff, is left as it is.
 */
const rotateGaps = async (gapIds: string[]) => {
  if (gapIds.length === 0) {
    return;
  }
  await db()
    .update(l2OpenGapTable)
    .set({ lastRequestedAt: new Date() })
    .where(inArray(l2OpenGapTable.id, gapIds));
};

/**
 * Replaces a row whose missing heights are no longer one run of at most the
 * row width (partly filled, or recorded before rows were capped) by one row
 * per run. The new rows start without request history: rows from before the
 * backoff carry counts in the thousands, which would park them at the 6h
 * maximum. A run matching a fulfilled row reopens it (and resets it).
 * Heights above the chain tip are not known to be missing yet: they stay one
 * row, with the original row's history.
 */
const splitGapRow = async (
  gap: OpenGap,
  runs: GapRange[],
  chainTip: number,
) => {
  logger.info(
    `Splitting L2 open gap ${gap.id} into ${runs.length} row(s) of its missing heights`,
  );
  await db().transaction(async (dbTx) => {
    await upsertOpenGaps({ ranges: runs, reason: gap.reason, executor: dbTx });
    if (gap.toHeight > chainTip) {
      const history = {
        requestCount: gap.requestCount,
        lastRequestedAt: gap.lastRequestedAt,
      };
      await dbTx
        .insert(l2OpenGapTable)
        .values({
          id: gapId({ from: chainTip + 1, to: gap.toHeight, reason: gap.reason }),
          l2NetworkId: gap.l2NetworkId,
          fromHeight: chainTip + 1,
          toHeight: gap.toHeight,
          reason: gap.reason,
          statusHint: gap.statusHint,
          status: "open",
          firstSeenAt: gap.firstSeenAt,
          ...history,
        })
        .onConflictDoUpdate({
          target: l2OpenGapTable.id,
          set: { status: "open", fulfilledAt: null, ...history },
        });
    }
    await dbTx.delete(l2OpenGapTable).where(eq(l2OpenGapTable.id, gap.id));
  });
};

const markGapsRequested = async (gapIds: string[]) => {
  if (gapIds.length === 0) {
    return;
  }
  await db()
    .update(l2OpenGapTable)
    .set({
      requestCount: sql`${l2OpenGapTable.requestCount} + 1`,
      lastRequestedAt: new Date(),
    })
    .where(inArray(l2OpenGapTable.id, gapIds));
};

/**
 * Picks what to request: due gaps, least recently requested first, each
 * requested whole while the range and block budgets last. A gap with every
 * height present is fulfilled; one whose missing heights are no longer a
 * single run of at most the row width is split for the next tick; one that
 * overlaps heights already in flight waits.
 */
const selectGapRequest = async ({
  chainTip,
  maxBlocks,
  maxRanges,
}: {
  chainTip: number;
  maxBlocks: number;
  maxRanges: number;
}) => {
  const now = Date.now();
  const maxWidth = gapRowMaxWidth(maxBlocks, maxRanges);
  const due = await getDueGaps(chainTip, now);
  if (due.length === 0) {
    return { ranges: [], gapIds: [] };
  }

  const spanFrom = Math.min(...due.map((gap) => gap.fromHeight));
  const spanTo = Math.min(chainTip, Math.max(...due.map((gap) => gap.toHeight)));
  const isInFlight = coverageOf(
    await getOpenGapsOverlapping(spanFrom, spanTo, { inFlightAt: now }),
  );
  const present = await findPresentHeights(
    due.map((gap) => ({
      from: gap.fromHeight,
      to: Math.min(gap.toHeight, chainTip),
    })),
  );

  const ranges: GapRange[] = [];
  const gapIds: string[] = [];
  const fulfilled: string[] = [];
  const rotated: string[] = [];
  const toSplit: Array<{ gap: OpenGap; runs: GapRange[] }> = [];
  const requestedHeights = new Set<number>();
  let blocks = 0;
  for (const gap of due) {
    if (ranges.length >= maxRanges) {
      break;
    }
    const upper = Math.min(gap.toHeight, chainTip);
    const missing: number[] = [];
    for (let height = gap.fromHeight; height <= upper; height++) {
      if (!present.has(height)) {
        missing.push(height);
      }
    }
    if (missing.length === 0) {
      if (gap.toHeight <= chainTip) {
        fulfilled.push(gap.id);
      } else {
        rotated.push(gap.id);
      }
      continue;
    }
    const runs = rangesFromHeights(missing).flatMap((run) =>
      splitRange(run, maxWidth),
    );
    const [run] = runs;
    if (run.from !== gap.fromHeight || run.to !== gap.toHeight) {
      toSplit.push({ gap, runs });
      continue;
    }
    const size = run.to - run.from + 1;
    const heights = Array.from({ length: size }, (_, i) => run.from + i);
    if (
      heights.some((height) => requestedHeights.has(height) || isInFlight(height))
    ) {
      rotated.push(gap.id);
      continue;
    }
    // Rows are at most maxBlocks / maxRanges wide, so the range cap binds
    // first; the block check only guards that invariant.
    if (blocks + size > maxBlocks) {
      continue;
    }
    ranges.push(run);
    gapIds.push(gap.id);
    blocks += size;
    heights.forEach((height) => requestedHeights.add(height));
  }
  await fulfilGaps(fulfilled);
  await rotateGaps(rotated);
  for (const { gap, runs } of toSplit) {
    await splitGapRow(gap, runs, chainTip);
  }
  return { ranges, gapIds };
};

const resolveReconciliationRollupVersion = async (): Promise<number | null> => {
  return (
    (await getCurrentRollupVersionNumber()) ??
    getLatestBlockRollupVersion()
  );
};

export const findMissingHeightsInWindow = async ({
  from,
  upperBound,
}: {
  from: number;
  upperBound: number;
}) => {
  const present = await findPresentHeights([{ from, to: upperBound }]);
  const missing: number[] = [];
  for (let height = from; height <= upperBound; height++) {
    if (!present.has(height)) {
      missing.push(height);
    }
  }
  return missing;
};

// Active, current-version heights present in any of the ranges, in one query.
const findPresentHeights = async (ranges: Array<{ from: number; to: number }>) => {
  if (ranges.length === 0) {
    return new Set<number>();
  }
  const effectiveVersion = await resolveReconciliationRollupVersion();
  const rows = await db()
    .select({ height: l2Block.height })
    .from(l2Block)
    .where(
      and(
        or(
          ...ranges.map((range) =>
            and(
              gte(l2Block.height, BigInt(range.from)),
              lte(l2Block.height, BigInt(range.to)),
            ),
          ),
        ),
        isNull(l2Block.orphan_timestamp),
        ...(effectiveVersion === null
          ? []
          : [eq(l2Block.version, effectiveVersion)]),
      ),
    );
  return new Set(rows.map((row) => Number(row.height)));
};

const getReconciliationUpperBound = async () => {
  const tips = await getTips();
  const latestHeight = await getLatestHeight();
  const upperBound = tips?.proposed.number ?? (latestHeight ? Number(latestHeight) : 0);
  return { tips, upperBound };
};

export const buildMissingBlockRangeRequest = async ({
  reason,
  scanWindow = L2_BLOCK_RECONCILIATION_SCAN_WINDOW,
  maxBlocks = L2_BLOCK_RECONCILIATION_MAX_BLOCKS,
}: {
  reason: Extract<L2BlockRangeRequestReason, "startup" | "cadence">;
  scanWindow?: number;
  maxBlocks?: number;
}): Promise<PlannedRangeRequest | null> => {
  const { upperBound } = await getReconciliationUpperBound();
  if (!Number.isSafeInteger(upperBound) || upperBound < 1) {
    logger.info(`Skipping ${reason} L2 block reconciliation: no upper bound`);
    return null;
  }
  const maxRanges = L2_BLOCK_RECONCILIATION_MAX_RANGES;

  // Record newly missing heights as gap rows. Heights an open gap already
  // covers are skipped before the budget applies, and the newest are kept,
  // so gaps that cannot be filled never crowd out discovery near the tip.
  const from = Math.max(1, upperBound - scanWindow + 1);
  const allMissing = await findMissingHeightsInWindow({ from, upperBound });
  const isCovered = coverageOf(await getOpenGapsOverlapping(from, upperBound));
  const uncovered = allMissing.filter((height) => !isCovered(height));
  const missing = uncovered.slice(-maxBlocks);
  const maxWidth = gapRowMaxWidth(maxBlocks, maxRanges);
  const ranges = rangesFromHeights(missing).flatMap((range) =>
    splitRange(range, maxWidth),
  );
  if (ranges.length > 0) {
    await upsertOpenGaps({ ranges, reason });
  }

  const { ranges: requestRanges, gapIds } = await selectGapRequest({
    chainTip: upperBound,
    maxBlocks,
    maxRanges,
  });
  if (requestRanges.length === 0) {
    logger.info(`${reason} L2 block reconciliation found no open gaps due for a request`);
    return null;
  }
  logger.info(
    `${reason} L2 block reconciliation requesting ${requestRanges.length} open gaps; scanWindow=${from}-${upperBound}; newlyDiscoveredMissing=${missing.length}; notYetRecorded=${uncovered.length - missing.length}`,
  );

  return {
    request: {
      requestId: randomUUID(),
      requestedAt: Date.now(),
      reason,
      ranges: requestRanges,
      maxBlocks,
    },
    markRequested: () => markGapsRequested(gapIds),
  };
};

const parseTipBoundaryHeight = (degradedReason: string | undefined) => {
  if (!degradedReason) {
    return null;
  }
  const match = /boundary block (\d+) (?:is missing|hash mismatch)/u.exec(degradedReason);
  if (!match?.[1]) {
    return null;
  }
  const height = Number(match[1]);
  return Number.isSafeInteger(height) && height > 0 ? height : null;
};

export const buildTipBoundaryRepairRequest =
  async (): Promise<PlannedRangeRequest | null> => {
    const tips = await getTips();
    const height = parseTipBoundaryHeight(tips?.degradedReason);
    if (!height) {
      return null;
    }
    const repairWindow = L2_BLOCK_RECONCILIATION_TIP_REPAIR_WINDOW;
    const from = Math.max(1, height - repairWindow);
    const to = height + repairWindow;
    const id = gapId({ from, to, reason: TIP_BOUNDARY_REASON });
    // The window is re-sent whole while the tips stay degraded (its heights
    // may be present but wrong), with the same backoff as other gaps,
    // whatever the row's status: blocks landing in the window fulfil it
    // without fixing a mismatch.
    const [existing] = await db()
      .select({ due: sql<boolean>`${gapDueSql(Date.now())}` })
      .from(l2OpenGapTable)
      .where(eq(l2OpenGapTable.id, id));
    if (existing && !existing.due) {
      return null;
    }
    const range = { from, to, statusHint: "proposed" as const };
    // Reopening must not reset the backoff here: the row is "fulfilled" as
    // soon as its heights are present, mismatch or not.
    await upsertOpenGaps({
      reason: TIP_BOUNDARY_REASON,
      ranges: [range],
      resetOnReopen: false,
    });
    logger.warn(
      `Requesting L2 tip-boundary repair around block ${height}: ${from}-${to}; reason=${tips?.degradedReason}`,
    );
    return {
      request: {
        requestId: randomUUID(),
        requestedAt: Date.now(),
        reason: TIP_BOUNDARY_REASON,
        ranges: [range],
        maxBlocks: Math.min(L2_BLOCK_RECONCILIATION_MAX_BLOCKS, to - from + 1),
      },
      markRequested: () => markGapsRequested([id]),
    };
  };

export const markOpenGapsFulfilledByHeight = async (height: bigint) => {
  const candidateGaps = await db()
    .select()
    .from(l2OpenGapTable)
    .where(
      and(
        eq(l2OpenGapTable.l2NetworkId, L2_NETWORK_ID),
        eq(l2OpenGapTable.status, "open"),
        lte(l2OpenGapTable.fromHeight, Number(height)),
        gte(l2OpenGapTable.toHeight, Number(height)),
      ),
    );

  for (const gap of candidateGaps) {
    const missing = await findMissingHeightsInWindow({
      from: gap.fromHeight,
      upperBound: gap.toHeight,
    });
    if (missing.length === 0) {
      await fulfilGaps([gap.id]);
    }
  }
};
