import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { HexString } from "@chicmoz-pkg/types";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { logger } from "../../../../logger.js";
import { droppedTx } from "../../../database/schema/dropped-tx/index.js";
import { body, l2Block, txEffect } from "../../schema/index.js";
import { withChainLock } from "../chain-lock.js";

/**
 * Removes a dropped transaction by its hash
 *
 * @param txHash The hash of the transaction to remove
 * @returns The number of entries removed (0 or 1)
 */
export const removeDroppedTxByHash = async (
  txHash: HexString,
  executor: ReturnType<typeof db> = db(),
): Promise<number> => {
  const deletedEntries = await executor
    .delete(droppedTx)
    .where(eq(droppedTx.txHash, txHash))
    .returning();

  if (deletedEntries.length > 0) {
    logger.info(`🗑️🔥 removed dropped tx ${txHash}`);
  }

  return deletedEntries.length;
};

/** Removes the dropped rows of txs a canonical block holds: those are mined. */
export const removeMinedDroppedTxs = async (): Promise<number> => {
  const { rowCount } = await withChainLock((dbTx) =>
    dbTx.delete(droppedTx).where(
      exists(
        dbTx
          .select({ one: sql`1` })
          .from(txEffect)
          .innerJoin(body, eq(txEffect.bodyId, body.id))
          .innerJoin(l2Block, eq(body.blockHash, l2Block.hash))
          .where(
            and(
              eq(txEffect.txHash, droppedTx.txHash),
              isNull(l2Block.orphan_timestamp),
            ),
          ),
      ),
    ),
  );
  logger.info(`🗑️🗑️🔥🔥 removed ${rowCount ?? 0} dropped txs that are mined`);
  return rowCount ?? 0;
};
