import { L2TipsEvent } from "@chicmoz-pkg/message-registry";
import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import {
  ChicmozL2Block,
  ChicmozL2NativeBlockStatus,
  ChicmozL2Tips,
  HexString,
  L2NetworkId,
  chicmozL2TipsSchema,
} from "@chicmoz-pkg/types";
import { and, desc, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import { L2_NETWORK_ID } from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import { l2ReorgBlockTable } from "../../schema/l2/reorg.js";
import {
  l2TipBoundaryMismatchTable,
  l2TipsTable,
  StoredL2Tips,
} from "../../schema/l2/tips.js";
import { l2Block } from "../../schema/l2block/index.js";
import { withChainLock } from "../chain-lock.js";
import { type DbTx } from "../utils.js";
import { getCurrentRollupVersionNumber } from "./chain-info/rollup-version-cache.js";

type TipBucket = "finalized" | "proven" | "checkpointed" | "proposed";

type BoundaryValidationResult = {
  bucket: TipBucket;
  height: number;
  expectedHash: HexString;
  observedDbHash: HexString | null;
  reason: string;
};

const toStoredTips = (row: typeof l2TipsTable.$inferSelect): StoredL2Tips => ({
  proposed: { number: row.proposedBlockNumber, hash: row.proposedBlockHash },
  proposedCheckpoint:
    row.proposedCheckpointBlockNumber !== null &&
    row.proposedCheckpointBlockHash !== null &&
    row.proposedCheckpointNumber !== null &&
    row.proposedCheckpointHash !== null
      ? {
          block: {
            number: row.proposedCheckpointBlockNumber,
            hash: row.proposedCheckpointBlockHash,
          },
          checkpoint: {
            number: row.proposedCheckpointNumber,
            hash: row.proposedCheckpointHash,
          },
        }
      : undefined,
  checkpointed: {
    block: { number: row.checkpointedBlockNumber, hash: row.checkpointedBlockHash },
    checkpoint: {
      number: row.checkpointedCheckpointNumber,
      hash: row.checkpointedCheckpointHash,
    },
  },
  proven: {
    block: { number: row.provenBlockNumber, hash: row.provenBlockHash },
    checkpoint: { number: row.provenCheckpointNumber, hash: row.provenCheckpointHash },
  },
  finalized: {
    block: { number: row.finalizedBlockNumber, hash: row.finalizedBlockHash },
    checkpoint: {
      number: row.finalizedCheckpointNumber,
      hash: row.finalizedCheckpointHash,
    },
  },
  observedAt: row.observedAt,
  source: {
    rpcNodeName: row.aztecNodeName ?? undefined,
    aztecNodeVersion: row.aztecNodeVersion ?? undefined,
  },
  degradedReason: row.degradedReason ?? undefined,
});

const flattenTips = (
  { tips, observedAt, source }: L2TipsEvent,
  degradedReason: string | null,
) => ({
  l2NetworkId: L2_NETWORK_ID,
  proposedBlockNumber: tips.proposed.number,
  proposedBlockHash: tips.proposed.hash,
  proposedCheckpointBlockNumber: tips.proposedCheckpoint?.block.number,
  proposedCheckpointBlockHash: tips.proposedCheckpoint?.block.hash,
  proposedCheckpointNumber: tips.proposedCheckpoint?.checkpoint.number,
  proposedCheckpointHash: tips.proposedCheckpoint?.checkpoint.hash,
  checkpointedBlockNumber: tips.checkpointed.block.number,
  checkpointedBlockHash: tips.checkpointed.block.hash,
  checkpointedCheckpointNumber: tips.checkpointed.checkpoint.number,
  checkpointedCheckpointHash: tips.checkpointed.checkpoint.hash,
  provenBlockNumber: tips.proven.block.number,
  provenBlockHash: tips.proven.block.hash,
  provenCheckpointNumber: tips.proven.checkpoint.number,
  provenCheckpointHash: tips.proven.checkpoint.hash,
  finalizedBlockNumber: tips.finalized.block.number,
  finalizedBlockHash: tips.finalized.block.hash,
  finalizedCheckpointNumber: tips.finalized.checkpoint.number,
  finalizedCheckpointHash: tips.finalized.checkpoint.hash,
  observedAt,
  aztecNodeName: source.rpcNodeName,
  aztecNodeVersion: source.aztecNodeVersion,
  degradedReason,
  updatedAt: new Date(),
});

type Executor = ReturnType<typeof db>;

const getBoundaryBlock = async (
  executor: Executor,
  height: number,
  rollupVersion: number | null,
) => {
  const versionFilter =
    rollupVersion !== null ? eq(l2Block.version, rollupVersion) : undefined;
  const rows = await executor
    .select({ hash: l2Block.hash })
    .from(l2Block)
    .where(
      and(
        eq(l2Block.height, BigInt(height)),
        versionFilter,
        isNull(l2Block.orphan_timestamp),
      ),
    )
    .limit(1);
  return rows[0]?.hash;
};

const missingBoundaryReason = (bucket: TipBucket, height: number) =>
  `${bucket} boundary block ${height} is missing`;

const validateBoundary = async (
  executor: Executor,
  bucket: TipBucket,
  tips: ChicmozL2Tips,
  rollupVersion: number | null,
): Promise<BoundaryValidationResult | null> => {
  const tip = bucket === "proposed" ? tips.proposed : tips[bucket].block;
  const boundaryHash = await getBoundaryBlock(
    executor,
    tip.number,
    rollupVersion,
  );
  if (!boundaryHash) {
    return {
      bucket,
      height: tip.number,
      expectedHash: tip.hash,
      observedDbHash: null,
      reason: missingBoundaryReason(bucket, tip.number),
    };
  }
  if (boundaryHash !== tip.hash) {
    return {
      bucket,
      height: tip.number,
      expectedHash: tip.hash,
      observedDbHash: boundaryHash,
      reason: `${bucket} boundary block ${tip.number} hash mismatch: db=${boundaryHash} tip=${tip.hash}`,
    };
  }
  return null;
};

const findBoundaryMismatch = async (
  executor: Executor,
  tips: ChicmozL2Tips,
  rollupVersion: number | null,
): Promise<BoundaryValidationResult | null> => {
  for (const bucket of [
    "finalized",
    "proven",
    "checkpointed",
    "proposed",
  ] as const) {
    const mismatch = await validateBoundary(
      executor,
      bucket,
      tips,
      rollupVersion,
    );
    if (mismatch) {
      return mismatch;
    }
  }
  return null;
};

const mismatchId = ({
  bucket,
  height,
  expectedHash,
  observedDbHash,
}: BoundaryValidationResult) =>
  `${L2_NETWORK_ID}:${bucket}:${height}:${expectedHash}:${observedDbHash ?? "missing"}`;

const recordBoundaryMismatch = async (
  executor: Executor,
  mismatch: BoundaryValidationResult,
  rollupVersion: number | null,
) => {
  const values = {
    id: mismatchId(mismatch),
    l2NetworkId: L2_NETWORK_ID,
    bucket: mismatch.bucket,
    height: mismatch.height,
    expectedHash: mismatch.expectedHash,
    observedDbHash: mismatch.observedDbHash,
    reason: mismatch.reason,
    lastSeenAt: new Date(),
    resolvedAt: null,
    rollupVersion,
  };

  await executor
    .insert(l2TipBoundaryMismatchTable)
    .values(values)
    .onConflictDoUpdate({
      target: l2TipBoundaryMismatchTable.id,
      set: {
        reason: values.reason,
        lastSeenAt: values.lastSeenAt,
        occurrenceCount: sql`${l2TipBoundaryMismatchTable.occurrenceCount} + 1`,
        resolvedAt: null,
        rollupVersion,
      },
    });
};

const MISMATCH_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the open mismatches whose cause is gone: the canonical block at
 * the height has the hash the tips named, a reorg record lists that hash, or
 * the mismatch was last seen a day ago. Tips that validate at other heights
 * resolve nothing.
 */
const resolveBoundaryMismatches = async (executor: Executor) => {
  const mismatch = l2TipBoundaryMismatchTable;
  await executor
    .update(mismatch)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(mismatch.l2NetworkId, L2_NETWORK_ID),
        isNull(mismatch.resolvedAt),
        or(
          lt(mismatch.lastSeenAt, new Date(Date.now() - MISMATCH_EXPIRY_MS)),
          exists(
            executor
              .select({ one: sql`1` })
              .from(l2Block)
              .where(
                and(
                  eq(l2Block.hash, mismatch.expectedHash),
                  eq(l2Block.height, mismatch.height),
                  isNull(l2Block.orphan_timestamp),
                ),
              ),
          ),
          exists(
            executor
              .select({ one: sql`1` })
              .from(l2ReorgBlockTable)
              .where(eq(l2ReorgBlockTable.hash, mismatch.expectedHash)),
          ),
        ),
      ),
    );
};

const recordValidation = async (
  executor: Executor,
  mismatch: BoundaryValidationResult | null,
  rollupVersion: number | null,
) => {
  if (mismatch) {
    await recordBoundaryMismatch(executor, mismatch, rollupVersion);
  }
  await resolveBoundaryMismatches(executor);
};

/**
 * Validates and stores tips under the network's chain lock: tips validated
 * before a chain change and written after it would describe a chain that no
 * longer exists.
 */
export const upsertTips = async (event: L2TipsEvent) => {
  const tips = chicmozL2TipsSchema.parse(event.tips);
  const rollupVersion = await getCurrentRollupVersionNumber();
  await withChainLock(async (dbTx) => {
    const mismatch = await findBoundaryMismatch(dbTx, tips, rollupVersion);
    if (mismatch) {
      logger.warn(`L2 tips degraded: ${mismatch.reason}`);
    }
    const values = flattenTips({ ...event, tips }, mismatch?.reason ?? null);
    await dbTx.insert(l2TipsTable).values(values).onConflictDoUpdate({
      target: l2TipsTable.l2NetworkId,
      set: values,
    });
    await recordValidation(dbTx, mismatch, rollupVersion);
  });
};

/**
 * Validates the stored tips again inside a chain change, healthy or
 * degraded: the change may have stored a block they name, or demoted one.
 * An unchanged result writes nothing, so a mismatch's occurrence count
 * counts tips events.
 */
export const revalidateTips = async (dbTx: DbTx) => {
  const [row] = await dbTx
    .select()
    .from(l2TipsTable)
    .where(eq(l2TipsTable.l2NetworkId, L2_NETWORK_ID))
    .limit(1);
  if (!row) {
    return;
  }
  const rollupVersion = await getCurrentRollupVersionNumber();
  const mismatch = await findBoundaryMismatch(
    dbTx,
    toStoredTips(row),
    rollupVersion,
  );
  const degradedReason = mismatch?.reason ?? null;
  if (degradedReason === row.degradedReason) {
    return;
  }
  await dbTx
    .update(l2TipsTable)
    .set({ degradedReason, updatedAt: new Date() })
    .where(eq(l2TipsTable.l2NetworkId, L2_NETWORK_ID));
  if (mismatch) {
    logger.warn(`L2 tips degraded: ${mismatch.reason}`);
  } else {
    logger.info(`L2 tips valid again (was: ${row.degradedReason})`);
  }
  await recordValidation(dbTx, mismatch, rollupVersion);
};

/**
 * The heights of the open mismatches, most recently seen first: those of
 * `rollupVersion`, and those recorded before mismatches carried a version.
 */
export const getUnresolvedBoundaryHeights = async (
  rollupVersion: number | null,
  limit: number,
): Promise<number[]> => {
  const mismatch = l2TipBoundaryMismatchTable;
  const rows = await db()
    .select({ height: mismatch.height })
    .from(mismatch)
    .where(
      and(
        eq(mismatch.l2NetworkId, L2_NETWORK_ID),
        isNull(mismatch.resolvedAt),
        rollupVersion === null
          ? undefined
          : or(
              isNull(mismatch.rollupVersion),
              eq(mismatch.rollupVersion, rollupVersion),
            ),
      ),
    )
    .orderBy(desc(mismatch.lastSeenAt))
    .limit(limit);
  return [...new Set(rows.map(({ height }) => height))];
};

export const getRecentBoundaryMismatches = async (
  l2NetworkId: L2NetworkId = L2_NETWORK_ID,
) => {
  return db()
    .select()
    .from(l2TipBoundaryMismatchTable)
    .where(eq(l2TipBoundaryMismatchTable.l2NetworkId, l2NetworkId))
    .orderBy(desc(l2TipBoundaryMismatchTable.lastSeenAt))
    .limit(10);
};

export const getTips = async (
  l2NetworkId: L2NetworkId = L2_NETWORK_ID,
): Promise<StoredL2Tips | null> => {
  const rows = await db()
    .select()
    .from(l2TipsTable)
    .where(eq(l2TipsTable.l2NetworkId, l2NetworkId))
    .limit(1);
  return rows[0] ? toStoredTips(rows[0]) : null;
};

type StatusTipHeights = Record<TipBucket, number>;

/**
 * The tip heights block statuses derive from, or null while the stored tips
 * cannot be trusted. A missing proposed boundary block is usually one still on
 * its way, so heights up to the validated checkpointed tip keep their status
 * and only those above it are unknown.
 */
export const statusTipHeights = (
  storedTips: StoredL2Tips | null,
): StatusTipHeights | null => {
  if (!storedTips) {
    return null;
  }
  const heights = {
    finalized: storedTips.finalized.block.number,
    proven: storedTips.proven.block.number,
    checkpointed: storedTips.checkpointed.block.number,
    proposed: storedTips.proposed.number,
  };
  if (!storedTips.degradedReason) {
    return heights;
  }
  if (
    storedTips.degradedReason ===
    missingBoundaryReason("proposed", storedTips.proposed.number)
  ) {
    return { ...heights, proposed: heights.checkpointed };
  }
  return null;
};

export const deriveNativeStatus = (
  block: Pick<ChicmozL2Block, "height" | "hash" | "orphan">,
  storedTips: StoredL2Tips | null,
): ChicmozL2NativeBlockStatus => {
  const tips = statusTipHeights(storedTips);
  if (!tips || block.orphan) {
    return "unknown";
  }

  const height = Number(block.height);
  if (!Number.isSafeInteger(height) || height > tips.proposed) {
    return "unknown";
  }
  if (height <= tips.finalized) {
    return "finalized";
  }
  if (height <= tips.proven) {
    return "proven";
  }
  if (height <= tips.checkpointed) {
    return "checkpointed";
  }
  return "proposed";
};
