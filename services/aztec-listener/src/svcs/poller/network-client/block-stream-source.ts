// getL2Tips, getBlockData and getBlocks adapt @aztec-labs/pxe 6.0.0
// (src/block_synchronizer/block_stream_source.ts, Apache-2.0), which the
// package does not export.
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { AbortError } from "@aztec-labs/foundation/error";
import {
  type BlockData,
  type BlockHash,
  type BlockQuery,
  type BlocksQuery,
  L2Block,
  type L2BlockId,
  type L2BlockStreamSource,
  type L2Tips,
  type L2TipsStoreBase,
} from "@aztec-labs/stdlib/block";
import { type BlockHeader } from "@aztec-labs/stdlib/tx";
import {
  AZTEC_MAX_PRUNE_DEPTH,
  AZTEC_STREAM_PREFIX_ALERT_MS,
  AZTEC_TIPS_PROBE_TIMEOUT_MS,
} from "../../../environment.js";
import { logger } from "../../../logger.js";
import {
  type ElectionReader,
  type OpenElectionReader,
  boundedElectionReaders,
} from "./election-probe.js";
import { callNodeFunction } from "./index.js";
import { type RpcNode, getOnlineRpcNodes } from "./pool.js";

/** The pin holds until a preferred node is more than this many blocks ahead of it. */
const PIN_LEAD = 2;
const SET_ASIDE_MS = 5 * 60_000;

/** A node answered as no honest node does. */
export class NodeCheckError extends Error {
  override readonly name = "NodeCheckError";
}

/** What the election reads from the listener's block stream store. */
export type ElectionStore = Pick<L2TipsStoreBase, "getL2Tips"> & {
  anyVersionStored(): Promise<boolean>;
};

export type StickySourceDeps = {
  store: ElectionStore;
  /** The old listener's `heights.chainProvenBlockHeight`: the first start's floor. */
  legacyProvenHeight: () => Promise<number>;
  nodes?: () => RpcNode[];
  openReader?: OpenElectionReader;
  now?: () => number;
};

export type StickySourceConfig = {
  maxPruneDepth: number;
  /** How long the first start waits under the floor before it alerts, and between alerts. */
  waitAlertMs: number;
};

type Probe = { node: RpcNode; tips?: L2Tips; eligible: boolean };
type Candidate = Probe & { tips: L2Tips };

const sameNode = (a: RpcNode | undefined, b: RpcNode | undefined) =>
  a !== undefined && b !== undefined && a.url === b.url;

const describeTips = (tips: L2Tips | undefined) =>
  tips === undefined
    ? "no tips"
    : `proposed ${tips.proposed.number}, proven ${tips.proven.block.number}, finalized ${tips.finalized.block.number}`;

/**
 * The genesis hash the store starts from: the SDK's constant fits only an
 * empty genesis. Throws when the node does not serve block 0.
 */
export const readGenesisBlockHash = async (
  node: RpcNode,
): Promise<BlockHash> => {
  const genesis = await callNodeFunction("getBlock", [BlockNumber.ZERO], node);
  if (genesis === undefined) {
    throw new Error(
      `Node ${node.name} does not serve block 0, so the block stream has no genesis hash`,
    );
  }
  const number = genesis.header.globalVariables.blockNumber;
  if (number !== BlockNumber.ZERO) {
    throw new NodeCheckError(
      `Node ${node.name} answered block 0 with block ${number}`,
    );
  }
  return genesis.header.hash();
};

/** Why `block`'s body does not match its header, when it does not. */
export const bodyFault = async (block: L2Block): Promise<string | undefined> =>
  (await block.body.computeTxEffectsTreeRoot()).equals(
    block.header.txEffectsTreeRoot,
  )
    ? undefined
    : `sent block ${block.number} with a body that does not match its header`;

// The stream asks for the height after the last block it got, so a block
// below `from` would repeat the download forever. An empty range only aborts
// the pass, and the node would win the next election again.
const blocksFault = async (
  from: number,
  limit: number,
  blocks: L2Block[],
  tip: number | undefined,
) => {
  if (blocks.length > limit) {
    return `sent ${blocks.length} blocks for a limit of ${limit}`;
  }
  if (blocks.length === 0 && tip !== undefined && from <= tip) {
    return `sent no block from ${from}, at or below its own tip ${tip}`;
  }
  for (const [i, block] of blocks.entries()) {
    if (block.number !== from + i) {
      return `sent block ${block.number} where ${from + i} was asked`;
    }
    const fault = await bodyFault(block);
    if (fault !== undefined) {
      return fault;
    }
  }
  return undefined;
};

const blockDataFault = async (query: BlockQuery, header: BlockHeader) => {
  const number = header.globalVariables.blockNumber;
  if ("number" in query && number !== query.number) {
    return `sent block ${number} where ${query.number} was asked`;
  }
  if ("hash" in query && !(await header.hash()).equals(query.hash)) {
    return `sent a header that does not hash to ${query.hash.toString()}`;
  }
  return undefined;
};

/**
 * The block stream's source. `elect()` picks one node before each pass, and
 * every read of that pass goes to it. A node whose answer fails a check
 * fails the pass and sits out the elections for five minutes.
 */
export class StickySource implements L2BlockStreamSource {
  private pinnedNode: RpcNode | undefined;
  private prefixNode: RpcNode | undefined;
  private readonly setAsideUntil = new Map<string, number>();
  private readonly finalizedChecks = new Map<
    string,
    { number: number; hash: string; matches: boolean }
  >();
  private blockReads = 0;
  private latestTips: L2Tips | undefined;
  private latestError: Error | undefined;
  private versionStored = false;
  private floorWait: { since: number; alertedAt?: number } | undefined;
  private readonly nodes: () => RpcNode[];
  private readonly openReader: OpenElectionReader;
  private readonly now: () => number;

  constructor(
    private readonly deps: StickySourceDeps,
    private readonly config: StickySourceConfig = {
      maxPruneDepth: AZTEC_MAX_PRUNE_DEPTH,
      waitAlertMs: AZTEC_STREAM_PREFIX_ALERT_MS,
    },
  ) {
    this.nodes = deps.nodes ?? getOnlineRpcNodes;
    this.openReader =
      deps.openReader ?? boundedElectionReaders(AZTEC_TIPS_PROBE_TIMEOUT_MS);
    this.now = deps.now ?? (() => Date.now());
  }

  get pinned(): RpcNode | undefined {
    return this.pinnedNode;
  }

  /** The pinned node's latest tips in this pass. */
  get lastTips(): L2Tips | undefined {
    return this.latestTips;
  }

  /** The latest failed read of this pass; the stream only logs it. */
  get lastError(): Error | undefined {
    return this.latestError;
  }

  /**
   * Picks the node for the next pass, once per pass: the SDK reads the tips
   * again after a walk-back, and that read must not switch nodes. Returns
   * undefined when no node is eligible, and every read then aborts the pass.
   */
  async elect(): Promise<RpcNode | undefined> {
    this.blockReads = 0;
    this.latestTips = undefined;
    this.latestError = undefined;
    const stored = await this.deps.store.getL2Tips();
    const floor = await this.bootstrapFloor();
    const now = this.now();
    const probes = await Promise.all(
      this.nodes()
        .filter((node) => (this.setAsideUntil.get(node.url) ?? 0) <= now)
        .map((node) => this.probe(node, stored.finalized.block)),
    );

    let eligible = probes.filter(
      (p): p is Candidate =>
        p.eligible &&
        p.tips !== undefined &&
        (floor === undefined || p.tips.proposed.number >= floor),
    );
    // A node whose last pass ended on the prefix rule sits out once: else a
    // tie could re-elect the same shorter copy of the chain every pass.
    const prefixNode = this.prefixNode;
    this.prefixNode = undefined;
    if (eligible.some((c) => !sameNode(c.node, prefixNode))) {
      eligible = eligible.filter((c) => !sameNode(c.node, prefixNode));
    }
    if (eligible.length === 0) {
      this.pinnedNode = undefined;
      this.noteNoEligibleNode(stored.finalized.block.number, floor, now);
      return undefined;
    }
    this.floorWait = undefined;

    // An L1 reorg can remove a proof from every honest node, hence the fallback.
    let preferred = eligible.filter(
      (c) => c.tips.proven.block.number >= stored.proven.block.number,
    );
    if (preferred.length === 0) {
      logger.warn(
        `No eligible node is at or above the block stream's proven tip ${stored.proven.block.number}; electing among nodes behind on proofs`,
      );
      preferred = eligible;
    }
    const best = preferred.reduce((a, b) =>
      b.tips.proposed.number > a.tips.proposed.number ? b : a,
    );
    const current = preferred.find((c) => sameNode(c.node, this.pinnedNode));
    const next =
      current !== undefined &&
      best.tips.proposed.number <= current.tips.proposed.number + PIN_LEAD
        ? current
        : best;
    if (!sameNode(next.node, this.pinnedNode)) {
      const before = probes.find((p) => sameNode(p.node, this.pinnedNode));
      logger.info(
        `Block stream pins ${next.node.name} (${describeTips(next.tips)}); before: ${
          this.pinnedNode?.name ?? "none"
        } (${describeTips(before?.tips)})`,
      );
      this.pinnedNode = next.node;
    }
    return next.node;
  }

  /** The pass ended on the prefix rule: unpin, and keep the node out of the next election if another is eligible. */
  endPassOnPrefix(): void {
    this.prefixNode = this.pinnedNode;
    this.pinnedNode = undefined;
  }

  /** Keeps the pinned node out of the elections for five minutes. */
  setAsidePinned(reason: string): void {
    if (this.pinnedNode !== undefined) {
      this.setAside(this.pinnedNode, reason);
    }
  }

  getL2Tips(): Promise<L2Tips> {
    return this.read(async (node) => {
      const tips = await callNodeFunction("getChainTips", [], node);
      this.latestTips = tips;
      return tips;
    });
  }

  getBlockData(query: BlockQuery): Promise<BlockData | undefined> {
    return this.read(async (node) => {
      // Bounds the walk-back on a node that disagrees with every stored hash.
      if (++this.blockReads > this.config.maxPruneDepth + 2) {
        this.fail(
          node,
          `took more than ${this.config.maxPruneDepth + 2} block reads in one pass`,
        );
      }
      const response = await callNodeFunction("getBlock", [query], node);
      if (response === undefined) {
        return undefined;
      }
      await this.check(node, blockDataFault(query, response.header));
      return {
        header: response.header,
        archive: response.archive,
        blockHash: response.hash,
        checkpointNumber: response.checkpointNumber,
        indexWithinCheckpoint: response.indexWithinCheckpoint,
      };
    });
  }

  getBlocks(query: BlocksQuery): Promise<L2Block[]> {
    // Epoch lookups are not exposed on the public AztecNode RPC; only `from + limit` is.
    if (!("from" in query)) {
      return Promise.reject(
        new Error("getBlocks with epoch query not supported via AztecNode RPC"),
      );
    }
    if (query.onlyCheckpointed) {
      return Promise.reject(
        new Error(
          "getBlocks with onlyCheckpointed not supported via AztecNode RPC",
        ),
      );
    }
    return this.read(async (node) => {
      const responses = await callNodeFunction(
        "getBlocks",
        [query.from, query.limit, { includeTransactions: true }],
        node,
      );
      const blocks = responses.map(
        ({ archive, header, body, checkpointNumber, indexWithinCheckpoint }) =>
          body === undefined
            ? this.fail(
                node,
                `sent block ${header.globalVariables.blockNumber} without its body`,
              )
            : new L2Block(
                archive,
                header,
                body,
                checkpointNumber,
                indexWithinCheckpoint,
              ),
      );
      await this.check(
        node,
        blocksFault(
          query.from,
          query.limit,
          blocks,
          this.latestTips?.proposed.number,
        ),
      );
      return blocks;
    });
  }

  private async read<T>(fn: (node: RpcNode) => Promise<T>): Promise<T> {
    const node = this.pinnedNode;
    if (node === undefined) {
      throw new AbortError();
    }
    try {
      return await fn(node);
    } catch (e) {
      this.latestError = e as Error;
      throw e;
    }
  }

  private async check(node: RpcNode, fault: Promise<string | undefined>) {
    const reason = await fault;
    if (reason !== undefined) {
      this.fail(node, reason);
    }
  }

  private fail(node: RpcNode, reason: string): never {
    const error = new NodeCheckError(`Node ${node.name} ${reason}`);
    this.setAside(node, error.message);
    throw error;
  }

  private setAside(node: RpcNode, reason: string) {
    this.setAsideUntil.set(node.url, this.now() + SET_ASIDE_MS);
    if (sameNode(node, this.pinnedNode)) {
      this.pinnedNode = undefined;
    }
    logger.warn(
      `${reason}; ${node.name} sits out the block stream elections for ${
        SET_ASIDE_MS / 60_000
      } minutes`,
    );
  }

  private async probe(node: RpcNode, finalized: L2BlockId): Promise<Probe> {
    try {
      const reader = this.openReader(node);
      const tips = await reader.getChainTips();
      // The stream reports a lower finalized tip too, which would point the
      // store below hashes it already deleted.
      const eligible =
        tips.finalized.block.number >= finalized.number &&
        (await this.agreesOnFinalized(node, reader, tips, finalized));
      return { node, tips, eligible };
    } catch (e) {
      logger.warn(
        `Node ${node.name} sits out this block stream election: ${(e as Error).message}`,
      );
      return { node, eligible: false };
    }
  }

  // A node on another finalized chain would overwrite the store's finalized
  // history and lock every honest node out. A finalized block never changes,
  // so one answer per node holds until the store's finalized tip moves.
  private async agreesOnFinalized(
    node: RpcNode,
    reader: ElectionReader,
    tips: L2Tips,
    finalized: L2BlockId,
  ): Promise<boolean> {
    const cached = this.finalizedChecks.get(node.url);
    if (cached?.number === finalized.number && cached.hash === finalized.hash) {
      return cached.matches;
    }
    const hash =
      tips.finalized.block.number === finalized.number
        ? tips.finalized.block.hash
        : await reader.getBlockHash(finalized.number);
    if (hash === undefined) {
      throw new Error(
        `no block at ${finalized.number}, below its finalized tip ${tips.finalized.block.number}`,
      );
    }
    const matches = hash === finalized.hash;
    this.finalizedChecks.set(node.url, { ...finalized, matches });
    if (!matches) {
      logger.warn(
        `Node ${node.name} has another block at the block stream's finalized height ${finalized.number}; it cannot drive the stream`,
      );
    }
    return matches;
  }

  // Proven blocks move back only on an L1 reorg, so a first tip at or above
  // the old listener's proven height removes at most the unproven blocks.
  private async bootstrapFloor(): Promise<number | undefined> {
    if (!this.versionStored) {
      this.versionStored = await this.deps.store.anyVersionStored();
    }
    return this.versionStored ? undefined : this.deps.legacyProvenHeight();
  }

  private noteNoEligibleNode(
    finalized: number,
    floor: number | undefined,
    now: number,
  ) {
    if (floor === undefined) {
      logger.warn(
        `No node is eligible to drive the block stream from finalized block ${finalized}; skipping this pass`,
      );
      return;
    }
    this.floorWait ??= { since: now };
    const message = `No eligible node is at or above the old listener's proven height ${floor}; the block stream waits`;
    const { since, alertedAt } = this.floorWait;
    if (now - (alertedAt ?? since) >= this.config.waitAlertMs) {
      logger.error(`${message} (${Math.round((now - since) / 1000)}s so far)`);
      this.floorWait.alertedAt = now;
    } else {
      logger.warn(message);
    }
  }
}
