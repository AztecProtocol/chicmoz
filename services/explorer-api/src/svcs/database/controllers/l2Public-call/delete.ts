import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import type { ChicmozL2PendingTx } from "@chicmoz-pkg/types";
import { eq } from "drizzle-orm";
import { l2TxPublicCallRequest } from "../../schema/index.js";

export const deletePublicCall = async (
  txHash: ChicmozL2PendingTx["txHash"],
  executor: ReturnType<typeof db> = db(),
): Promise<void> => {
  await executor
    .delete(l2TxPublicCallRequest)
    .where(eq(l2TxPublicCallRequest.txHash, txHash));
};
