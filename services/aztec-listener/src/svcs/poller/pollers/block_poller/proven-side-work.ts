import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import {
  AZTEC_BLOCK_STREAM_BATCH_SIZE,
  AZTEC_PROVEN_SIDE_WORK_MAX,
} from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import { type StickySource } from "../../network-client/block-stream-source.js";
import {
  type ReadPublicStorage,
  handleProvenTransactions,
} from "./handle-proven-block-txs.js";

export type ProvenSideWorkDeps = {
  source: Pick<StickySource, "getBlocks" | "pinnedRead">;
  /** The pinned node's proven tip, as the store holds it after a settled pass. */
  provenTip: number;
  readCursor: () => Promise<number>;
  storeCursor: (height: number) => Promise<void>;
};

/**
 * Runs the proven blocks above the cursor, at most `max` of them, from the
 * pinned node, and moves the cursor past each block that completed. A failed
 * block stops the run, so the next pass retries it.
 */
export const runProvenSideWork = async (
  { source, provenTip, readCursor, storeCursor }: ProvenSideWorkDeps,
  { max, batchSize } = {
    max: AZTEC_PROVEN_SIDE_WORK_MAX,
    batchSize: AZTEC_BLOCK_STREAM_BATCH_SIZE,
  },
) => {
  let cursor = await readCursor();
  // The cursor spans rollup versions, and a new version's heights start over.
  if (cursor > provenTip) {
    cursor = provenTip;
    await storeCursor(cursor);
  }
  const end = Math.min(provenTip, cursor + max);
  const readStorage: ReadPublicStorage = (block, contract, slot) =>
    source.pinnedRead("getPublicStorageAt", [block, contract, slot]);
  while (cursor < end) {
    const blocks = await source.getBlocks({
      from: BlockNumber(cursor + 1),
      limit: Math.min(batchSize, end - cursor),
    });
    // Below the snapshot's tip, so the source has benched the node.
    if (blocks.length === 0) {
      return;
    }
    for (const block of blocks) {
      const outcome = await handleProvenTransactions(block, readStorage);
      if (!outcome.ok) {
        logger.warn(
          `Proven side work stopped at block ${block.number}, which the next pass retries: ${outcome.error.message}`,
        );
        return;
      }
      cursor = block.number;
      await storeCursor(cursor);
    }
  }
};
