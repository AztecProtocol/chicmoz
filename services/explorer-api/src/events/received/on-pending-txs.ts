import { type EventHandler, type Heartbeat } from "@chicmoz-pkg/message-bus";
import {
  PendingTxsEvent,
  generateL2TopicName,
  getConsumerGroupId,
} from "@chicmoz-pkg/message-registry";
import { chicmozL2PendingTxSchema } from "@chicmoz-pkg/types";
import { SERVICE_NAME } from "../../constants.js";
import { L2_NETWORK_ID } from "../../environment.js";
import { logger } from "../../logger.js";
import { withChainLock } from "../../svcs/database/controllers/chain-lock.js";
import { storeOrUpdateL2Tx } from "../../svcs/database/controllers/l2Tx/index.js";
import { removeDroppedTxByHash } from "../../svcs/database/controllers/dropped-tx/index.js";
import { txEffectExists } from "../../svcs/database/controllers/l2TxEffect/get-tx-effect.js";

const onPendingTxs = async ({ txs }: PendingTxsEvent, heartbeat: Heartbeat) => {
  logger.info(`🕐 Received ${txs.length} pending txs to store`);

  for (const tx of txs) {
    // Each tx waits for the chain lock on its own.
    await heartbeat();
    const parsed = chicmozL2PendingTxSchema.safeParse(tx);
    if (!parsed.success) {
      logger.error(
        `Failed to parse pending tx ${tx.txHash}: ${parsed.error.message}`,
      );
      continue;
    }
    const res = parsed.data;
    await withChainLock(async (dbTx) => {
      if (await txEffectExists(res.txHash, dbTx)) {
        logger.info(`🕐 Pending tx ${res.txHash} is mined, skipping`);
        return;
      }
      // Handle resubmissions: remove from dropped table if exists
      const removedCount = await removeDroppedTxByHash(res.txHash, dbTx);
      if (removedCount > 0) {
        logger.info(
          `🔄 Resubmitted tx ${res.txHash}: removed from dropped table`,
        );
      }
      await storeOrUpdateL2Tx(res, dbTx);
      logger.debug(`✅ Stored/updated pending tx: ${res.txHash}`);
    });
  }
};

export const pendingTxHandler: EventHandler = {
  groupId: getConsumerGroupId({
    serviceName: SERVICE_NAME,
    networkId: L2_NETWORK_ID,
    handlerName: "pendingTxHandler",
  }),
  topic: generateL2TopicName(L2_NETWORK_ID, "PENDING_TXS_EVENT"),
  cb: onPendingTxs as (arg0: unknown, heartbeat: Heartbeat) => Promise<void>,
};
