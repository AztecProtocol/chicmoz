import {
  type ChicmozL2DroppedTx,
  chicmozL2DroppedTxSchema,
} from "@chicmoz-pkg/types";
import { aztecExplorer } from "~/service/constants";
import client, { isNotFoundError, validateResponse } from "./client";

export const DroppedTxAPI = {
  /** `null` for a tx with no dropped row: a failed refetch would keep the drop it last found. */
  getDroppedTxByHash: async (
    hash: string,
  ): Promise<ChicmozL2DroppedTx | null> => {
    try {
      const response = await client.get(
        aztecExplorer.getL2DroppedTxByHash(hash),
      );
      return validateResponse(chicmozL2DroppedTxSchema, response.data);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  },
};
