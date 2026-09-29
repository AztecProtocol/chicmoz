import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { type HexString } from "@chicmoz-pkg/types";
import { and, eq, gt, isNull } from "drizzle-orm";
import { logger } from "../../../../logger.js";
import {
  body,
  l2Block,
  txEffect,
} from "../../../database/schema/l2block/index.js";
import { storeDroppedTx } from "../../controllers/dropped-tx/store.js";

/**
 * Mark a block as orphaned with the specified parent status
 */
export const markBlockAsOrphaned = async (
  blockHash: HexString,
  timestamp: number,
  hasOrphanedParent: boolean,
): Promise<void> => {
  logger.info(
    `Marking block ${blockHash} as orphaned. hasOrphanedParent: ${hasOrphanedParent}`,
  );

  await db()
    .update(l2Block)
    .set({
      orphan_timestamp: timestamp,
      orphan_hasOrphanedParent: hasOrphanedParent,
    })
    .where(eq(l2Block.hash, blockHash));
};

/**
 * Mark all blocks with height > targetHeight and orphan_timestamp === null as orphaned
 * @returns The number of blocks that were marked as orphaned
 */
export const markHigherBlocksAsOrphaned = async (
  targetHeight: bigint,
  timestamp: number,
): Promise<number> => {
  logger.info(
    `Marking all blocks with height > ${targetHeight} as orphaned with parent`,
  );

  // Find all blocks with higher height that aren't already orphaned
  const higherBlocks = await db()
    .select({ hash: l2Block.hash })
    .from(l2Block)
    .where(
      and(gt(l2Block.height, targetHeight), isNull(l2Block.orphan_timestamp)),
    );

  const orphanedCount = higherBlocks.length;

  // Mark them all as orphaned with hasOrphanedParent=true
  for (const block of higherBlocks) {
    await markBlockAsOrphaned(block.hash, timestamp, true);
  }

  logger.info(`Marked ${orphanedCount} child blocks as orphaned`);
  return orphanedCount;
};

type DbExecutor = ReturnType<typeof db>;

/**
 * Orphans the blocks a replacement displaces, in the caller's transaction:
 * the given blocks, and when `descendantsAbove` is set every active block of
 * the rollup version above that height (they were built on the replaced
 * block). Their txs are recorded as dropped.
 */
export const orphanReplacedBlocks = async (
  dbTx: DbExecutor,
  {
    hashes,
    descendantsAbove,
    rollupVersion,
  }: {
    hashes: HexString[];
    descendantsAbove: bigint | null;
    rollupVersion: number;
  },
  now: number,
): Promise<void> => {
  for (const hash of hashes) {
    logger.info(`Orphaning replaced block ${hash}`);
    await dbTx
      .update(l2Block)
      .set({ orphan_timestamp: now, orphan_hasOrphanedParent: false })
      .where(eq(l2Block.hash, hash));
    await recordBlockTxsAsDropped(dbTx, hash, now);
  }
  if (descendantsAbove === null) {
    return;
  }

  // Only on the same rollup version: other rollups reuse the same heights.
  const higherBlocks = await dbTx
    .select({ hash: l2Block.hash })
    .from(l2Block)
    .where(
      and(
        gt(l2Block.height, descendantsAbove),
        isNull(l2Block.orphan_timestamp),
        eq(l2Block.version, rollupVersion),
      ),
    );
  for (const block of higherBlocks) {
    await dbTx
      .update(l2Block)
      .set({ orphan_timestamp: now, orphan_hasOrphanedParent: true })
      .where(eq(l2Block.hash, block.hash));
    await recordBlockTxsAsDropped(dbTx, block.hash, now);
  }
  logger.info(
    `Orphaned ${hashes.length} replaced block(s) and ${higherBlocks.length} block(s) above height ${descendantsAbove}`,
  );
};

/**
 * Un-orphan a block by clearing its orphan_timestamp and orphan_hasOrphanedParent fields.
 * This is used when we receive a block with the same hash as an already-orphaned block,
 * meaning the orphaned block is actually the canonical one.
 */
export const unOrphanBlock = async (
  dbTx: DbExecutor,
  blockHash: HexString,
): Promise<void> => {
  logger.info(`Un-orphaning block ${blockHash}`);
  await dbTx
    .update(l2Block)
    .set({
      orphan_timestamp: null,
      orphan_hasOrphanedParent: false,
    })
    .where(eq(l2Block.hash, blockHash));
};

/**
 * Records a displaced block's txs as dropped, in the caller's transaction,
 * except those in `keep` (txs the block replacing it includes).
 */
export const recordBlockTxsAsDropped = async (
  dbTx: DbExecutor,
  blockHash: HexString,
  timestamp: number,
  keep: ReadonlySet<HexString> = new Set(),
): Promise<void> => {
  // Find the body ID for this block
  const blockBody = await dbTx
    .select({ id: body.id })
    .from(body)
    .where(eq(body.blockHash, blockHash))
    .limit(1);

  if (blockBody.length === 0) {
    logger.warn(`No body found for orphaned block ${blockHash}`);
    return;
  }

  const bodyId = blockBody[0].id;

  // Find all transaction effects in this body
  const txEffects = (
    await dbTx
      .select({
        txHash: txEffect.txHash,
        txBirthTimestamp: txEffect.txBirthTimestamp,
      })
      .from(txEffect)
      .where(eq(txEffect.bodyId, bodyId))
  ).filter((tx) => !keep.has(tx.txHash));

  if (txEffects.length === 0) {
    logger.info(`No transaction effects found in orphaned block ${blockHash}`);
    return;
  }

  logger.info(
    `Found ${txEffects.length} transaction effects to mark as dropped in block ${blockHash}`,
  );

  // Store each transaction effect as a dropped transaction. In the caller's
  // transaction, so a failure rolls the whole change back rather than being
  // logged and ignored.
  for (const tx of txEffects) {
    await storeDroppedTx(
      {
        txHash: tx.txHash,
        createdAsPendingAt: tx.txBirthTimestamp,
        droppedAt: timestamp,
        // Block was reorged out — tx returns to dropped-state with this
        // reason so the UI can show "(reorg)" rather than just a timestamp.
        dropReason: "orphaned",
      },
      dbTx,
    );
  }
};
