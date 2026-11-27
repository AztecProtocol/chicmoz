import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { type L2Block } from "@aztec-labs/stdlib/block";
import {
  AZTEC_BLOCK_STREAM_BATCH_SIZE,
  AZTEC_PROVEN_SIDE_WORK_MAX,
} from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import { type StickySource } from "../../network-client/block-stream-source.js";
import { redactUrls } from "../../network-client/redact-urls.js";
import {
  type ReadPublicStorage,
  handleProvenTransactions,
} from "./handle-proven-block-txs.js";

export type ProvenSideWorkDeps = {
  source: Pick<StickySource, "getBlocks" | "pinnedRead">;
  rollupVersion: number;
  /** The pinned node's proven tip, as the store holds it after a settled pass. */
  provenTip: number;
  /** The store's finalized tip; the store keeps no hashes below it. */
  finalizedTip: number;
  storedHash: (height: number) => Promise<string | undefined>;
  readCursor: () => Promise<number>;
  storeCursor: (height: number) => Promise<void>;
};

// The node can serve another block at a height once the pass has settled.
// Below the finalized tip, where a block cannot change, the store keeps no
// hash, so the side work trusts the pinned node's block there.
const onStoredChain = async (
  block: L2Block,
  { rollupVersion, finalizedTip, storedHash }: ProvenSideWorkDeps,
) => {
  if (
    block.header.globalVariables.version.toBigInt() !== BigInt(rollupVersion)
  ) {
    return false;
  }
  const stored = await storedHash(block.number);
  return stored === undefined
    ? block.number < finalizedTip
    : stored === (await block.hash()).toString();
};

/**
 * Runs the proven blocks above the cursor, at most `max` of them, from the
 * pinned node, and moves the cursor past each block that completed. A failed
 * block, or one off the stored chain, stops the run, so the next pass retries
 * it.
 */
export const runProvenSideWork = async (
  deps: ProvenSideWorkDeps,
  { max, batchSize } = {
    max: AZTEC_PROVEN_SIDE_WORK_MAX,
    batchSize: AZTEC_BLOCK_STREAM_BATCH_SIZE,
  },
) => {
  const { source, provenTip, readCursor, storeCursor } = deps;
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
      if (!(await onStoredChain(block, deps))) {
        logger.warn(
          `Proven side work stopped at block ${block.number}, which is not the block the block stream stored there; the next pass retries`,
        );
        return;
      }
      const outcome = await handleProvenTransactions(block, readStorage);
      if (!outcome.ok) {
        logger.warn(
          `Proven side work stopped at block ${block.number}, which the next pass retries: ${redactUrls(outcome.error.message)}`,
        );
        return;
      }
      cursor = block.number;
      await storeCursor(cursor);
    }
  }
};
