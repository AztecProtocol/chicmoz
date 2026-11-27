import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import {
  L2BlockStream,
  type L2TipsStoreBase,
  localTipsMatch,
} from "@aztec-labs/stdlib/block";
import {
  AZTEC_BLOCK_STREAM_BATCH_SIZE,
  AZTEC_DISABLE_LISTEN_FOR_PROPOSED_BLOCKS,
  AZTEC_DISABLE_LISTEN_FOR_PROVEN_BLOCKS,
  AZTEC_ENABLE_FULL_SWEEP_CATCHUP,
  AZTEC_LISTEN_FOR_L2_TIPS,
  AZTEC_TIPS_PROBE_TIMEOUT_MS,
  BLOCK_POLL_INTERVAL_MS,
  CHAIN_INFO_POLL_INTERVAL_MS,
} from "../../../../environment.js";
import {
  onCatchupBlock,
  onOrderedBlock,
} from "../../../../events/emitted/index.js";
import { logger } from "../../../../logger.js";
import {
  getBlockHeights,
  lowerProcessedProvenBlockHeight,
  storeProcessedProposedBlockHeight,
  storeProcessedProvenBlockHeight,
} from "../../../database/heights.controller.js";
import { PostgresL2TipsStore } from "../../../database/l2-tips-store.js";
import { inTransaction } from "../../../database/transaction.js";
import { openAttestedReader } from "../../network-client/attested-reads.js";
import {
  StickySource,
  readGenesisBlockHash,
} from "../../network-client/block-stream-source.js";
import { getOnlineRpcNodes, getRpcNode } from "../../network-client/pool.js";
import {
  type ReportedVersion,
  readLatestRollupVersion,
} from "../../network-client/rollup-version.js";
import { publishTipsIfDue } from "../l2-tips-poller.js";
import { ChainPublisher } from "./chain-publisher.js";
import { runProvenSideWork } from "./proven-side-work.js";
import { streamLogger } from "./stream-logger.js";

/** One rollup version's block stream. */
export type StreamChain = {
  rollupVersion: number;
  store: Pick<L2TipsStoreBase, "getL2Tips" | "getL2BlockHash">;
  source: StickySource;
  publisher: ChainPublisher;
};

let started = false;
let cancelPolling = false;
let timeoutId: ReturnType<typeof setTimeout> | undefined;
let chain: StreamChain | undefined;
let latest: ReportedVersion | undefined;
let versionReadAt = Number.NEGATIVE_INFINITY;
let sweepHeight = 1;

/** The rollup version the stream follows, once it follows one. */
export const streamRollupVersion = () => chain?.rollupVersion;

const openChain = async ({
  node,
  version,
}: ReportedVersion): Promise<StreamChain> => {
  const store = new PostgresL2TipsStore(
    version,
    await readGenesisBlockHash(node),
  );
  const source = new StickySource({
    store,
    legacyProvenHeight: async () =>
      (await getBlockHeights()).chainProvenBlockHeight,
  });
  const publisher = new ChainPublisher({
    rollupVersion: version,
    store,
    source,
    publishBlock: onOrderedBlock,
    lowerProvenCursor: lowerProcessedProvenBlockHeight,
    transaction: inTransaction,
  });
  return { rollupVersion: version, store, source, publisher };
};

/**
 * The stream of the highest rollup version the nodes report, read again every
 * CHAIN_INFO_POLL_INTERVAL_MS. A new version starts a new store from the
 * reporting node's block 0; the old version's rows stay.
 */
export const currentChain = async (now = Date.now()): Promise<StreamChain> => {
  if (now - versionReadAt >= CHAIN_INFO_POLL_INTERVAL_MS) {
    latest =
      (await readLatestRollupVersion(
        getOnlineRpcNodes(),
        AZTEC_TIPS_PROBE_TIMEOUT_MS,
      )) ?? latest;
    versionReadAt = now;
  }
  if (latest === undefined) {
    throw new Error("No Aztec node reported its rollup version");
  }
  if (chain?.rollupVersion !== latest.version) {
    const next = await openChain(latest);
    if (chain !== undefined) {
      logger.warn(
        `Nodes report rollup version ${next.rollupVersion}; the block stream leaves version ${chain.rollupVersion} for a new store`,
      );
    }
    chain = next;
  }
  return chain;
};

/** One block of the full sweep, bounded by the store's tip, not the node's. */
const sweepOnce = async (storeTip: number, rollupVersion: number) => {
  if (!AZTEC_ENABLE_FULL_SWEEP_CATCHUP || storeTip === 0) {
    return;
  }
  const height = Math.min(sweepHeight, storeTip);
  const reader = await openAttestedReader(getRpcNode(), rollupVersion);
  const read = await reader.getBlock(height);
  if (read === undefined) {
    return;
  }
  await onCatchupBlock(
    read.block,
    "proposed",
    read.final ? { final: true } : {},
  );
  sweepHeight = (height + 1) % storeTip || 1;
};

const readProvenCursor = async () =>
  (await getBlockHeights()).processedProvenBlockHeight;

/**
 * One pass: the election and the stream, then the tips, the heights, the
 * proven side work and the full sweep. The tips and the side work need the
 * store to hold the pass's snapshot: an aborted pass's tips would contradict
 * its blocks, and its proven tip need not be the node's.
 */
export const runPass = async ({
  rollupVersion,
  store,
  source,
  publisher,
}: StreamChain) => {
  const before = await store.getL2Tips();
  if ((await source.elect()) !== undefined) {
    publisher.startPass();
    const empty = before.proposed.number === 0;
    try {
      await new L2BlockStream(
        source,
        source.localData,
        publisher,
        streamLogger,
        {
          batchSize: AZTEC_BLOCK_STREAM_BATCH_SIZE,
          // The stream reads this as it plans its downloads, after it read its
          // snapshot: an empty store starts at that snapshot's finalized
          // block, inclusive, and no history is replayed.
          get startingBlock() {
            return empty ? source.lastTips?.finalized.block.number : undefined;
          },
        },
      ).sync();
    } finally {
      publisher.finishPass();
    }
  }
  const after = await store.getL2Tips();
  const snapshot = source.lastTips;
  const settled = snapshot !== undefined && localTipsMatch(after, snapshot);
  if (settled && AZTEC_LISTEN_FOR_L2_TIPS) {
    await publishTipsIfDue(snapshot);
  }
  const moved = after.proposed.number !== before.proposed.number;
  if (moved) {
    await storeProcessedProposedBlockHeight(after.proposed.number);
  }
  if (settled && !AZTEC_DISABLE_LISTEN_FOR_PROVEN_BLOCKS) {
    await runProvenSideWork({
      source,
      rollupVersion,
      provenTip: after.proven.block.number,
      finalizedTip: after.finalized.block.number,
      storedHash: (height) => store.getL2BlockHash(BlockNumber(height)),
      readCursor: readProvenCursor,
      storeCursor: storeProcessedProvenBlockHeight,
    });
  }
  if (!moved) {
    await sweepOnce(after.proposed.number, rollupVersion);
  }
};

const tick = async () => {
  try {
    await runPass(await currentChain());
  } catch (e) {
    // A read with no node pinned; the next pass elects one.
    if ((e as Error).name !== "AbortError") {
      logger.error(`🐻 block stream pass failed: ${(e as Error).stack}`);
    }
  } finally {
    if (!cancelPolling) {
      timeoutId = setTimeout(() => void tick(), BLOCK_POLL_INTERVAL_MS);
    }
  }
};

/** Opens the stream for the nodes' rollup version; a node without block 0 stops the listener. */
export const init = async () => {
  if (!AZTEC_DISABLE_LISTEN_FOR_PROPOSED_BLOCKS) {
    await currentChain();
  }
};

export const startPolling = () => {
  if (started) {
    throw new Error("Poller already started");
  }
  started = true;
  logger.info(
    AZTEC_ENABLE_FULL_SWEEP_CATCHUP
      ? "Full-sweep catchup is enabled; listener will sweep historical blocks when live head is idle."
      : "Full-sweep catchup is disabled; request-driven reconciliation is the primary missing-block repair path.",
  );
  if (AZTEC_DISABLE_LISTEN_FOR_PROPOSED_BLOCKS) {
    logger.info(
      "AZTEC_DISABLE_LISTEN_FOR_PROPOSED_BLOCKS is set; the block stream does not run",
    );
    return;
  }
  void tick();
};

export const stopPolling = () => {
  cancelPolling = true;
  clearTimeout(timeoutId);
  timeoutId = undefined;
};
