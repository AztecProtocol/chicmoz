import { Tx, TxHash } from "@aztec/aztec.js/tx";

export const MAX_PENDING_TXS_PAGE_SIZE = 50;

export const getAllPendingTxs = async (
  fetchPage: (limit: number, after?: TxHash) => Promise<Tx[]>,
): Promise<Tx[]> => {
  const txs: Tx[] = [];
  const seenHashes = new Set<string>();
  let after: TxHash | undefined;
  let page: Tx[];

  do {
    page = await fetchPage(MAX_PENDING_TXS_PAGE_SIZE, after);

    for (const tx of page) {
      const hash = tx.getTxHash().toString();
      if (seenHashes.has(hash)) {
        throw new Error(
          `Aztec pending transaction pagination returned duplicate transaction ${hash}`,
        );
      }
      seenHashes.add(hash);
      txs.push(tx);
    }

    if (page.length < MAX_PENDING_TXS_PAGE_SIZE) {
      break;
    }

    const nextAfter = page[page.length - 1].getTxHash();
    if (nextAfter.toString() === after?.toString()) {
      throw new Error(
        `Aztec pending transaction pagination cursor did not advance from ${nextAfter.toString()}`,
      );
    }
    after = nextAfter;
  } while (page.length === MAX_PENDING_TXS_PAGE_SIZE);

  return txs;
};
