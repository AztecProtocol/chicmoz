import { type HexString } from "@chicmoz-pkg/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

type Range = [from: number, to: number];
type SeededGap = {
  height: number;
  requestCount: number;
  requestedAgoMs: number | null;
  seenAgoMs?: number;
};

const CURRENT = 2;
const OLD = 1;
// The tick spacing, and the backoff unit.
const CADENCE_MS = 120_000;
const MINUTE = 60_000;

const span = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const except = (heights: number[], holes: number[]) =>
  heights.filter((height) => !holes.includes(height));
const byFrom = (ranges: Range[] | null) =>
  ranges && [...ranges].sort(([a], [b]) => a - b);

// The scheduler on its real SQL. Blocks are bare l2Block rows: the scheduler
// reads nothing else. Time passes by moving every stored request time back,
// which is what the due filter compares against the wall clock.
describe("open gap scheduling on a real database", () => {
  let api: ExplorerApiForTest;
  let tick: () => Promise<Range[] | null>;
  let repairTick: () => Promise<Range[] | null>;
  let mismatches: (
    rows: Array<{ height: number; seenAgoMs: number; version?: number }>,
  ) => Promise<void>;
  let blocks: (heights: number[], version?: number) => Promise<void>;
  let arrive: (height: number) => Promise<void>;
  let orphan: (height: number) => Promise<void>;
  let repair: (height: number) => Promise<void>;
  let fulfil: (height: number) => Promise<void>;
  let seedGaps: (rows: SeededGap[]) => Promise<void>;
  let elapse: (ms: number) => Promise<void>;
  let openGaps: () => Promise<Range[]>;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    // The defaults, pinned: the expected ticks below follow from them.
    Object.assign(process.env, {
      L2_BLOCK_RECONCILIATION_INTERVAL_MS: String(CADENCE_MS),
      L2_BLOCK_RECONCILIATION_MAX_BLOCKS: "200",
      L2_BLOCK_RECONCILIATION_MAX_RANGES: "10",
      L2_BLOCK_RECONCILIATION_SCAN_WINDOW: "10000",
      L2_BLOCK_RECONCILIATION_TIP_REPAIR_WINDOW: "5",
    });
    api = await startExplorerApiForTest();
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { asc, eq, sql } = await import("drizzle-orm");
    const { l2OpenGapTable } = await import(
      "../../src/svcs/database/schema/l2/open-gap.js"
    );
    const { l2TipBoundaryMismatchTable } = await import(
      "../../src/svcs/database/schema/l2/tips.js"
    );
    const { l2Block } = await import(
      "../../src/svcs/database/schema/l2block/index.js"
    );
    const {
      buildMissingBlockRangeRequest,
      buildTipBoundaryRepairRequest,
      fulfilRepairHeight,
      markOpenGapsFulfilledByHeight,
      recordRepairHeights,
    } = await import(
      "../../src/svcs/database/controllers/l2block/missing-ranges.js"
    );
    const { observeRollupVersion } = await import(
      "../../src/svcs/database/controllers/l2/chain-info/rollup-version-cache.js"
    );
    await observeRollupVersion({
      l2NetworkId: "SANDBOX",
      rollupVersion: BigInt(CURRENT),
      source: "block",
    });

    const db = getDb();
    const hashOf = (height: number, version: number): HexString =>
      `0x${version.toString(16).padStart(2, "0")}${height.toString(16).padStart(62, "0")}`;
    // A tick whose publish succeeds: what it would send, then the marking
    // that follows the send.
    const sent = async (
      planned: Awaited<ReturnType<typeof buildMissingBlockRangeRequest>>,
    ) => {
      await planned?.markRequested();
      return planned
        ? planned.request.ranges.map(({ from, to }): Range => [from, to])
        : null;
    };
    tick = async () =>
      sent(await buildMissingBlockRangeRequest({ reason: "cadence" }));
    repairTick = async () => sent(await buildTipBoundaryRepairRequest());
    mismatches = async (rows) => {
      const now = Date.now();
      await db.insert(l2TipBoundaryMismatchTable).values(
        rows.map(({ height, seenAgoMs, version = CURRENT }) => ({
          id: `SANDBOX:proposed:${height}`,
          l2NetworkId: "SANDBOX" as const,
          bucket: "proposed" as const,
          height,
          expectedHash: hashOf(height, version),
          observedDbHash: null,
          reason: `proposed boundary block ${height} is missing`,
          firstSeenAt: new Date(now - seenAgoMs),
          lastSeenAt: new Date(now - seenAgoMs),
          rollupVersion: version,
        })),
      );
    };
    blocks = async (heights, version = CURRENT) => {
      await db.insert(l2Block).values(
        heights.map((height) => ({
          hash: hashOf(height, version),
          height: BigInt(height),
          version,
        })),
      );
    };
    // What blockHandler does for a stored block, minus storing its contents.
    arrive = async (height) => {
      await blocks([height]);
      await markOpenGapsFulfilledByHeight(BigInt(height));
    };
    orphan = async (height) => {
      await db
        .update(l2Block)
        .set({ orphan_timestamp: Date.now(), orphan_hasOrphanedParent: false })
        .where(eq(l2Block.hash, hashOf(height, CURRENT)));
    };
    repair = (height) => recordRepairHeights(db, [BigInt(height)]);
    // What a block message's change does when it makes its block canonical.
    fulfil = (height) => fulfilRepairHeight(db, BigInt(height));
    seedGaps = async (rows) => {
      const now = Date.now();
      await db.insert(l2OpenGapTable).values(
        rows.map((row) => ({
          id: `SANDBOX:cadence:${row.height}:${row.height}`,
          l2NetworkId: "SANDBOX" as const,
          fromHeight: row.height,
          toHeight: row.height,
          reason: "cadence" as const,
          statusHint: "proposed" as const,
          requestCount: row.requestCount,
          lastRequestedAt:
            row.requestedAgoMs === null
              ? null
              : new Date(now - row.requestedAgoMs),
          firstSeenAt: new Date(now - (row.seenAgoMs ?? 0)),
        })),
      );
    };
    elapse = async (ms) => {
      await db.update(l2OpenGapTable).set({
        lastRequestedAt: sql`${l2OpenGapTable.lastRequestedAt} - make_interval(secs => ${ms / 1000})`,
      });
    };
    openGaps = async () =>
      (
        await db
          .select({ from: l2OpenGapTable.fromHeight, to: l2OpenGapTable.toHeight })
          .from(l2OpenGapTable)
          .where(eq(l2OpenGapTable.status, "open"))
          .orderBy(asc(l2OpenGapTable.fromHeight))
      ).map(({ from, to }): Range => [from, to]);
    reset = async () => {
      await db.delete(l2OpenGapTable);
      await db.delete(l2TipBoundaryMismatchTable);
      await db.delete(l2Block);
    };
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await reset();
  });

  it("re-requests a discovered gap only once its backoff has passed", async () => {
    await blocks(except(span(1, 100), [...span(41, 65), 90]));

    const sent: Array<[tick: number, ranges: Range[]]> = [];
    for (let i = 0; i < 10; i++) {
      if (i > 0) {
        await elapse(CADENCE_MS);
      }
      const ranges = await tick();
      if (ranges) {
        sent.push([i, ranges]);
      }
    }

    // Discovery caps rows at 200 blocks / 10 ranges = 20 heights. After its
    // nth request a row waits 2^n cadences: requested at ticks 0, 2 and 6.
    const gaps: Range[] = [[41, 60], [61, 65], [90, 90]];
    expect(sent).toEqual([[0, gaps], [2, gaps], [6, gaps]]);
  });

  it("splits a partly filled gap and then requests only its missing heights", async () => {
    await blocks(except(span(1, 100), span(41, 45)));
    expect(await tick()).toEqual([[41, 45]]);
    await arrive(43);

    await elapse(CADENCE_MS);
    expect(await tick()).toBeNull();
    await elapse(CADENCE_MS);
    expect(await tick()).toBeNull();
    expect(await openGaps()).toEqual([[41, 42], [44, 45]]);
    await elapse(CADENCE_MS);
    // The two new rows tie on both sort keys.
    expect(byFrom(await tick())).toEqual([[41, 42], [44, 45]]);
  });

  it("restarts the backoff of a filled gap that reopens when its block is orphaned", async () => {
    await blocks(except(span(1, 100), [90]));
    expect(await tick()).toEqual([[90, 90]]);
    await arrive(90);
    expect(await openGaps()).toEqual([]);

    await elapse(CADENCE_MS / 2);
    await orphan(90);
    expect(await tick()).toEqual([[90, 90]]);
    // One request since reopening, so one doubling.
    await elapse(2 * CADENCE_MS);
    expect(await tick()).toEqual([[90, 90]]);
  });

  it("requests a repair row while its block is present, until a block message there fulfils it", async () => {
    await blocks(span(1, 100));
    await repair(50);

    expect(await tick()).toEqual([[50, 50]]);
    await fulfil(50);
    expect(await openGaps()).toEqual([]);
  });

  it("selects due rows before the candidate limit, with the backoff capped at an hour", async () => {
    const backedOff = span(101, 160);
    await blocks(except(span(1, 200), [...backedOff, 170, 180]));
    await seedGaps([
      // Requested 50 min ago with an hour of backoff left to wait. They sort
      // before the row at 180, and there are more of them than the
      // scheduler's 50 candidates.
      ...backedOff.map((height) => ({
        height,
        requestCount: 8,
        requestedAgoMs: 50 * MINUTE,
      })),
      // Due only through the one-hour cap; the count is the incident's.
      { height: 170, requestCount: 2_510, requestedAgoMs: 70 * MINUTE },
      { height: 180, requestCount: 1, requestedAgoMs: 10 * MINUTE },
    ]);

    expect(await tick()).toEqual([[170, 170], [180, 180]]);
  });

  it("sends the least recently seen of two due tip repairs first", async () => {
    await mismatches([
      { height: 700, seenAgoMs: 10 * MINUTE },
      { height: 600, seenAgoMs: 20 * MINUTE },
    ]);

    expect((await repairTick())?.[0]).toEqual([600, 600]);
    expect((await repairTick())?.[0]).toEqual([700, 700]);
  });

  it("sends a tip repair again once its window's backoff has passed, and not before", async () => {
    await mismatches([{ height: 500, seenAgoMs: MINUTE }]);
    expect((await repairTick())?.[0]).toEqual([500, 500]);

    // One request: the window waits two cadences.
    expect(await repairTick()).toBeNull();
    await elapse(2 * CADENCE_MS);
    expect((await repairTick())?.[0]).toEqual([500, 500]);
  });

  it("sends a due tip repair past more backed-off windows than the scheduler's candidates", async () => {
    // Each seen before the due mismatch at 900, and more of them than the
    // scheduler's 50 candidates. The first ticks request, and so back off,
    // these windows; the one at 3 starts at height 1.
    const backedOff = [3, ...span(1_001, 1_050)];
    await mismatches([
      // Never fetched: the listener starts at height 1.
      { height: 0, seenAgoMs: 180 * MINUTE },
      ...backedOff.map((height, i) => ({
        height,
        seenAgoMs: 120 * MINUTE - i * 1_000,
      })),
      { height: 950, seenAgoMs: 90 * MINUTE, version: OLD },
      { height: 900, seenAgoMs: 60 * MINUTE },
    ]);

    for (const height of backedOff) {
      expect((await repairTick())?.[0]).toEqual([height, height]);
    }
    expect(await repairTick()).toEqual([
      [900, 900],
      [895, 899],
      [901, 905],
    ]);
    expect(await repairTick()).toBeNull();
  });

  it("does not let old-version blocks or old-chain gap rows hide a current-version gap", async () => {
    // The old chain is ahead of the current one, as right after an upgrade.
    await blocks(span(1, 120), OLD);
    await blocks(except(span(1, 60), span(41, 45)));
    // Gap rows left by the old chain, above the current tip, older than any
    // row discovery will add, and as many as the scheduler's candidates.
    await seedGaps(
      span(1_001, 1_050).map((height) => ({
        height,
        requestCount: 0,
        requestedAgoMs: null,
        seenAgoMs: 24 * 60 * MINUTE,
      })),
    );

    expect(await tick()).toEqual([[41, 45]]);
  });
});
