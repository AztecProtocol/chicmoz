import { EventHandler } from "@chicmoz-pkg/message-bus";
import {
  DroppedTxsEvent,
  generateL2TopicName,
  getConsumerGroupId,
} from "@chicmoz-pkg/message-registry";
import { SERVICE_NAME } from "../../constants.js";
import { L2_NETWORK_ID } from "../../environment.js";
import { logger } from "../../logger.js";
import { withChainLock } from "../../svcs/database/controllers/chain-lock.js";
import { storeDroppedTx } from "../../svcs/database/controllers/dropped-tx/store.js";
import { deleteTx } from "../../svcs/database/controllers/l2Tx/index.js";
import { txEffectExists } from "../../svcs/database/controllers/l2TxEffect/get-tx-effect.js";
import { deletePublicCall } from "../../svcs/database/controllers/l2Public-call/delete.js";
import { deleteL2ToL1Msgs } from "../../svcs/database/controllers/l2PendingL2ToL1Msg/delete.js";

const onDroppedTxs = async ({ txs }: DroppedTxsEvent) => {
  logger.info(`🗑️ Received ${txs.length} dropped txs to handle`);

  for (const droppedTx of txs) {
    await withChainLock(async (dbTx) => {
      if (await txEffectExists(droppedTx.txHash, dbTx)) {
        logger.info(`🗑️ Dropped tx ${droppedTx.txHash} is mined, skipping`);
        return;
      }
      await storeDroppedTx(droppedTx, dbTx);
      await deletePublicCall(droppedTx.txHash, dbTx);
      await deleteL2ToL1Msgs(droppedTx.txHash, dbTx);
      await deleteTx(droppedTx.txHash, dbTx);
    });
  }
};

export const droppedTxHandler: EventHandler = {
  groupId: getConsumerGroupId({
    serviceName: SERVICE_NAME,
    networkId: L2_NETWORK_ID,
    handlerName: "droppedTxHandler",
  }),
  topic: generateL2TopicName(L2_NETWORK_ID, "DROPPED_TXS_EVENT"),
  cb: onDroppedTxs as (arg0: unknown) => Promise<void>,
};
