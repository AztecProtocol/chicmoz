import { type HexString } from "@chicmoz-pkg/types";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../../../../logger.js";
import { droppedTx } from "../../../database/schema/dropped-tx/index.js";
import { txEffect } from "../../../database/schema/l2block/body.js";
import { l2Tx } from "../../../database/schema/l2tx/index.js";
import { type DbTx } from "../utils.js";

/**
 * For txs now mined on the canonical chain: deletes their pending rows,
 * copying each pending tx's fee and identity fields onto its tx effect, and
 * their dropped rows, whether or not a pending row existed.
 */
export const removePendingAndDroppedTx = async (
  dbTx: DbTx,
  txHashes: HexString[],
): Promise<void> => {
  if (txHashes.length === 0) {
    return;
  }
  const pending = await dbTx
    .delete(l2Tx)
    .where(inArray(l2Tx.txHash, txHashes))
    .returning({
      txHash: l2Tx.txHash,
      feePayer: l2Tx.feePayer,
      feePaymentMethod: l2Tx.feePaymentMethod,
      initiator: l2Tx.initiator,
    });
  for (const pendingTx of pending) {
    logger.info(`🕐🔥 deleted pending tx ${pendingTx.txHash}`);
    await dbTx
      .update(txEffect)
      .set({
        feePayer: pendingTx.feePayer ?? null,
        feePaymentMethod: pendingTx.feePaymentMethod ?? null,
        initiator: pendingTx.initiator ?? null,
      })
      .where(eq(txEffect.txHash, pendingTx.txHash));
  }
  const dropped = await dbTx
    .delete(droppedTx)
    .where(inArray(droppedTx.txHash, txHashes))
    .returning({ txHash: droppedTx.txHash });
  for (const { txHash } of dropped) {
    logger.info(`🗑️🔥 removed dropped tx ${txHash}`);
  }
};
