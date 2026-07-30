import { Tx, TxHash } from "@aztec/aztec.js/tx";
import { describe, expect, it, vi } from "vitest";
import {
  getAllPendingTxs,
  MAX_PENDING_TXS_PAGE_SIZE,
} from "../../src/svcs/poller/network-client/pending-txs.js";

const createTx = (index: number) =>
  ({
    getTxHash: () =>
      TxHash.fromString(`0x${index.toString(16).padStart(64, "0")}`),
  }) as Tx;

describe("getAllPendingTxs", () => {
  it("fetches every v5 pending transaction page", async () => {
    const txs = Array.from(
      { length: MAX_PENDING_TXS_PAGE_SIZE + 1 },
      (_, index) => createTx(index + 1),
    );
    const fetchPage = vi.fn(
      (limit: number, after?: TxHash): Promise<Tx[]> => {
        const start = after
          ? txs.findIndex(
              (tx) => tx.getTxHash().toString() === after.toString(),
            ) + 1
          : 0;
        return Promise.resolve(txs.slice(start, start + limit));
      },
    );

    await expect(getAllPendingTxs(fetchPage)).resolves.toEqual(txs);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1][1]?.toString()).toBe(
      txs[MAX_PENDING_TXS_PAGE_SIZE - 1].getTxHash().toString(),
    );
  });

  it("rejects a non-advancing or overlapping v5 page", async () => {
    const page = Array.from({ length: MAX_PENDING_TXS_PAGE_SIZE }, (_, index) =>
      createTx(index + 1),
    );
    const fetchPage = vi.fn(() => Promise.resolve(page));

    await expect(getAllPendingTxs(fetchPage)).rejects.toThrow(
      "returned duplicate transaction",
    );
  });
});
