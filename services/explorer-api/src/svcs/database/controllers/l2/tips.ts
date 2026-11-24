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
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { L2_NETWORK_ID } from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import {
  l2TipBoundaryMismatchTable,
  l2TipsTable,
  StoredL2Tips,
} from "../../schema/l2/tips.js";
import { l2Block } from "../../schema/l2block/index.js";
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

const getBoundaryBlock = async (height: number, rollupVersion: number | null) => {
  const versionFilter =
    rollupVersion !== null ? eq(l2Block.version, rollupVersion) : undefined;
  const rows = await db()
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
  bucket: TipBucket,
  tips: ChicmozL2Tips,
  rollupVersion: number | null,
): Promise<BoundaryValidationResult | null> => {
  const tip = bucket === "proposed" ? tips.proposed : tips[bucket].block;
  const boundaryHash = await getBoundaryBlock(tip.number, rollupVersion);
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

const mismatchId = ({
  bucket,
  height,
  expectedHash,
  observedDbHash,
}: BoundaryValidationResult) =>
  `${L2_NETWORK_ID}:${bucket}:${height}:${expectedHash}:${observedDbHash ?? "missing"}`;

const recordBoundaryMismatch = async (mismatch: BoundaryValidationResult) => {
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
  };

  await db()
    .insert(l2TipBoundaryMismatchTable)
    .values(values)
    .onConflictDoUpdate({
      target: l2TipBoundaryMismatchTable.id,
      set: {
        reason: values.reason,
        lastSeenAt: values.lastSeenAt,
        occurrenceCount: sql`${l2TipBoundaryMismatchTable.occurrenceCount} + 1`,
        resolvedAt: null,
      },
    });
};

const resolveBoundaryMismatches = async () => {
  const database = db();
  if (typeof database.update !== "function") {
    return;
  }
  await database
    .update(l2TipBoundaryMismatchTable)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(l2TipBoundaryMismatchTable.l2NetworkId, L2_NETWORK_ID),
        isNull(l2TipBoundaryMismatchTable.resolvedAt),
      ),
    );
};

const findBoundaryMismatch = async (
  tips: ChicmozL2Tips,
): Promise<BoundaryValidationResult | null> => {
  const rollupVersion = await getCurrentRollupVersionNumber();
  for (const bucket of ["finalized", "proven", "checkpointed", "proposed"] as const) {
    const mismatch = await validateBoundary(bucket, tips, rollupVersion);
    if (mismatch) {
      return mismatch;
    }
  }
  return null;
};

const recordValidation = async (mismatch: BoundaryValidationResult | null) => {
  if (mismatch) {
    await recordBoundaryMismatch(mismatch);
  } else {
    await resolveBoundaryMismatches();
  }
};

export const upsertTips = async (event: L2TipsEvent) => {
  const tips = chicmozL2TipsSchema.parse(event.tips);
  const mismatch = await findBoundaryMismatch(tips);
  if (mismatch) {
    logger.warn(`L2 tips degraded: ${mismatch.reason}`);
  }

  const values = flattenTips({ ...event, tips }, mismatch?.reason ?? null);
  await db()
    .insert(l2TipsTable)
    .values(values)
    .onConflictDoUpdate({
      target: l2TipsTable.l2NetworkId,
      set: values,
    });

  await recordValidation(mismatch);
};

/**
 * Validates degraded stored tips again, for when a block is stored: tips and
 * blocks arrive on separate topics, so tips often name a block that is stored
 * a moment later. Healthy tips cost one read; an unchanged result writes
 * nothing, so a mismatch's occurrence count still counts tips events.
 */
export const revalidateDegradedTips = async () => {
  const [row] = await db()
    .select()
    .from(l2TipsTable)
    .where(eq(l2TipsTable.l2NetworkId, L2_NETWORK_ID))
    .limit(1);
  if (!row?.degradedReason) {
    return;
  }
  const mismatch = await findBoundaryMismatch(toStoredTips(row));
  const degradedReason = mismatch?.reason ?? null;
  if (degradedReason === row.degradedReason) {
    return;
  }
  // Tips stored since the read were validated by upsertTips; keep its result.
  const updated = await db()
    .update(l2TipsTable)
    .set({ degradedReason, updatedAt: new Date() })
    .where(
      and(
        eq(l2TipsTable.l2NetworkId, L2_NETWORK_ID),
        eq(l2TipsTable.observedAt, row.observedAt),
        eq(l2TipsTable.degradedReason, row.degradedReason),
      ),
    )
    .returning({ l2NetworkId: l2TipsTable.l2NetworkId });
  if (updated.length === 0) {
    return;
  }
  if (mismatch) {
    logger.warn(`L2 tips degraded: ${mismatch.reason}`);
  } else {
    logger.info(`L2 tips valid again (was: ${row.degradedReason})`);
  }
  await recordValidation(mismatch);
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
