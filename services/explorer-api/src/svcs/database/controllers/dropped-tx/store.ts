import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { type ChicmozL2DroppedTx } from "@chicmoz-pkg/types";
import { logger } from "../../../../logger.js";
import { droppedTx } from "../../schema/dropped-tx/index.js";

export const storeDroppedTx = async (
  tx: ChicmozL2DroppedTx,
  executor: ReturnType<typeof db> = db(),
): Promise<void> => {
  const res = await executor
    .insert(droppedTx)
    .values(tx)
    .onConflictDoNothing()
    .returning();
  if (res.length > 0) {
    logger.info(`🗑️ Stored dropped tx: ${tx.txHash}`);
  }
};
