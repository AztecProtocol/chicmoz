// getL2Tips, getBlockData and getBlocks adapt @aztec-labs/pxe 6.0.0
// (src/block_synchronizer/block_stream_source.ts, Apache-2.0), which the
// package does not export.
import { type AztecNode } from "@aztec-labs/aztec.js/node";
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { AbortError, TimeoutError } from "@aztec-labs/foundation/error";
import {
  type BlockData,
  type BlockHash,
  type BlockQuery,
  type BlocksQuery,
  L2Block,
  type L2BlockId,
  type L2BlockStreamLocalDataProvider,
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
// One pinned read, retries included: the pool's HTTP client allows minutes per attempt.
const PINNED_READ_TIMEOUT_MS = 60_000;

/** A node answered as no honest node does. */
export class NodeCheckError extends Error {
  override readonly name = "NodeCheckError";
}

export type ElectionStore = Pick<
  L2TipsStoreBase,
  "getL2Tips" | "getL2BlockHash"
> & {
  otherVersionStored(): Promise<boolean>;
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

/** What every snapshot of one pass is checked against. */
type PassBounds = { finalized: L2BlockId; floor: number | undefined };
type Pin = { node: RpcNode; bounds: PassBounds };
type Probe = { node: RpcNode; tips?: L2Tips; eligible: boolean };
type Candidate = Probe & { tips: L2Tips };

const sameNode = (a: RpcNode | undefined, b: RpcNode | undefined) =>
  a !== undefined && b !== undefined && a.url === b.url;

const sameBlock = (a: L2BlockId, b: L2BlockId) =>
  a.number === b.number && a.hash === b.hash;

const describeTips = (tips: L2Tips | undefined) =>
  tips === undefined
    ? "no tips"
    : `proposed ${tips.proposed.number}, proven ${tips.proven.block.number}, finalized ${tips.finalized.block.number}`;

// The checks a snapshot needs no read for. The stream reports a lower
// finalized tip too, which would point the store below hashes it deleted.
const tipsFault = (
  tips: L2Tips,
  { finalized, floor }: PassBounds,
): string | undefined => {
  const theirs = tips.finalized.block;
  if (theirs.number < finalized.number) {
    return `is finalized at block ${theirs.number}, below the block stream's ${finalized.number}`;
  }
  if (theirs.number === finalized.number && theirs.hash !== finalized.hash) {
    return `has another block at the block stream's finalized height ${finalized.number}`;
  }
  if (floor !== undefined && tips.proposed.number < floor) {
    return `is at block ${tips.proposed.number}, below the old listener's proven height ${floor}`;
  }
  return undefined;
};

const withDeadline = async <T>(
  work: Promise<T>,
  ms: number,
  error: () => Error,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

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
// below `from` would repeat the download forever.
const blocksFault = async (from: number, limit: number, blocks: L2Block[]) => {
  if (blocks.length > limit) {
    return `sent ${blocks.length} blocks for a limit of ${limit}`;
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
  /** The store as the stream must read it: its hash lookups count against the walk bound. */
  readonly localData: L2BlockStreamLocalDataProvider;
  private pin: Pin | undefined;
  // Nodes whose last pass ended on the prefix rule or an empty range. They sit
  // out while another eligible node exists, so tied shorter copies cannot take
  // turns ahead of the node with the replacing block. Cleared once every
  // eligible node is in it, or after a pass that stored its snapshot's tip.
  private readonly shorterCopies = new Set<string>();
  private readonly setAsideUntil = new Map<string, number>();
  private readonly finalizedMatches = new Map<string, L2BlockId>();
  private blockReads = 0;
  private hashLookups = 0;
  private latestTips: L2Tips | undefined;
  private latestError: Error | undefined;
  private floorLifted = false;
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
    this.localData = {
      getL2Tips: () => deps.store.getL2Tips(),
      getL2BlockHash: (number) =>
        this.recorded(() => {
          this.walkStep(++this.hashLookups, "stored-hash lookups");
          return deps.store.getL2BlockHash(BlockNumber(number));
        }),
    };
  }

  get pinned(): RpcNode | undefined {
    return this.pin?.node;
  }

  get lastTips(): L2Tips | undefined {
    return this.latestTips;
  }

  /** The latest failed read of this pass; the stream only logs it. */
  get lastError(): Error | undefined {
    return this.latestError;
  }

  /**
   * Picks the node for the next pass, or none when no node is eligible.
   * Callers run one complete pass at a time, `elect()` then `sync()`: the
   * pass's bounds and counters start here.
   */
  async elect(): Promise<RpcNode | undefined> {
    const stored = await this.deps.store.getL2Tips();
    if (
      this.latestTips !== undefined &&
      sameBlock(stored.proposed, this.latestTips.proposed)
    ) {
      this.shorterCopies.clear();
    }
    this.blockReads = 0;
    this.hashLookups = 0;
    this.latestTips = undefined;
    this.latestError = undefined;
    const bounds: PassBounds = {
      finalized: stored.finalized.block,
      floor: await this.bootstrapFloor(stored.proposed.number),
    };
    const now = this.now();
    const probes = await Promise.all(
      this.nodes()
        .filter((node) => (this.setAsideUntil.get(node.url) ?? 0) <= now)
        .map((node) => this.probe(node, bounds)),
    );

    let eligible = probes.filter(
      (p): p is Candidate => p.eligible && p.tips !== undefined,
    );
    if (eligible.some((c) => !this.shorterCopies.has(c.node.url))) {
      eligible = eligible.filter((c) => !this.shorterCopies.has(c.node.url));
    } else {
      this.shorterCopies.clear();
    }
    const pinned = this.pin?.node;
    if (eligible.length === 0) {
      this.pin = undefined;
      this.noteNoEligibleNode(stored.finalized.block.number, bounds.floor, now);
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
    const current = preferred.find((c) => sameNode(c.node, pinned));
    const next =
      current !== undefined &&
      best.tips.proposed.number <= current.tips.proposed.number + PIN_LEAD
        ? current
        : best;
    if (!sameNode(next.node, pinned)) {
      const before = probes.find((p) => sameNode(p.node, pinned));
      logger.info(
        `Block stream pins ${next.node.name} (${describeTips(next.tips)}); before: ${
          pinned?.name ?? "none"
        } (${describeTips(before?.tips)})`,
      );
    }
    this.pin = { node: next.node, bounds };
    return next.node;
  }

  /** The pass ended on the prefix rule: unpins the node and counts it among the shorter copies. */
  endPassOnPrefix(): void {
    if (this.pin !== undefined) {
      this.endPassShort(this.pin.node);
    }
  }

  /** Keeps the pinned node out of the elections for five minutes. */
  setAsidePinned(reason: string): void {
    if (this.pin !== undefined) {
      this.setAside(this.pin.node, reason);
    }
  }

  getL2Tips(): Promise<L2Tips> {
    return this.recorded(async () => {
      const { pin, result: tips } = await this.pinnedCall("getChainTips", []);
      // A restart or another backend behind the same URL can answer other
      // than the election's probe did.
      const fault = tipsFault(tips, pin.bounds);
      if (fault !== undefined) {
        const message = `Node ${pin.node.name} ${fault}; the block stream skips this pass`;
        logger.warn(message);
        throw new AbortError(message);
      }
      this.latestTips = tips;
      return tips;
    });
  }

  getBlockData(query: BlockQuery): Promise<BlockData | undefined> {
    return this.recorded(async () => {
      this.walkStep(++this.blockReads, "block reads");
      const { pin, result: response } = await this.pinnedCall("getBlock", [
        query,
      ]);
      if (response === undefined) {
        return undefined;
      }
      await this.check(pin.node, blockDataFault(query, response.header));
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
    return this.recorded(async () => {
      const { pin, result: responses } = await this.pinnedCall("getBlocks", [
        query.from,
        query.limit,
        { includeTransactions: true },
      ]);
      const tip = this.latestTips?.proposed.number;
      if (responses.length === 0 && tip !== undefined && query.from <= tip) {
        // An honest node that pruned after its tips were read answers so, and
        // the stream aborts the pass on an empty range.
        this.endPassShort(pin.node);
        return [];
      }
      const blocks = responses.map(
        ({ archive, header, body, checkpointNumber, indexWithinCheckpoint }) =>
          body === undefined
            ? this.fail(
                pin.node,
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
      await this.check(pin.node, blocksFault(query.from, query.limit, blocks));
      return blocks;
    });
  }

  private async recorded<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      this.latestError = e as Error;
      throw e;
    }
  }

  private async pinnedCall<K extends keyof AztecNode>(
    fnName: K,
    args: Parameters<AztecNode[K]>,
  ) {
    const pin = this.pin;
    if (pin === undefined) {
      throw new AbortError();
    }
    const result = await withDeadline(
      callNodeFunction(fnName, args, pin.node),
      PINNED_READ_TIMEOUT_MS,
      () =>
        new TimeoutError(
          `Node ${pin.node.name} did not answer ${String(fnName)} within ${
            PINNED_READ_TIMEOUT_MS / 1000
          } s`,
        ),
    );
    return { pin, result };
  }

  // Bounds the walk-back on a node that disagrees with every stored hash, or
  // whose chain ends below every hash the store holds. A depth-D prune takes
  // D+1 steps and at most one more read.
  private walkStep(count: number, what: string) {
    const bound = this.config.maxPruneDepth + 2;
    if (count <= bound) {
      return;
    }
    const node = this.pin?.node;
    if (node === undefined) {
      throw new AbortError();
    }
    this.fail(node, `took the block stream past ${bound} ${what} in one pass`);
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
    if (sameNode(node, this.pin?.node)) {
      this.pin = undefined;
    }
    logger.warn(
      `${reason}; ${node.name} sits out the block stream elections for ${
        SET_ASIDE_MS / 60_000
      } minutes`,
    );
  }

  private endPassShort(node: RpcNode) {
    this.shorterCopies.add(node.url);
    if (sameNode(node, this.pin?.node)) {
      this.pin = undefined;
    }
  }

  private async probe(node: RpcNode, bounds: PassBounds): Promise<Probe> {
    try {
      const reader = this.openReader(node);
      const tips = await reader.getChainTips();
      const fault =
        tipsFault(tips, bounds) ??
        (tips.finalized.block.number > bounds.finalized.number
          ? await this.aheadFault(node, reader, bounds.finalized)
          : undefined);
      if (fault !== undefined) {
        logger.warn(
          `Node ${node.name} sits out this block stream election: it ${fault}`,
        );
      }
      return { node, tips, eligible: fault === undefined };
    } catch (e) {
      logger.warn(
        `Node ${node.name} sits out this block stream election: ${(e as Error).message}`,
      );
      return { node, eligible: false };
    }
  }

  // A node finalized past the store must hold the store's finalized block, or
  // following it would overwrite the store's finalized history and lock every
  // honest node out. A finalized block never changes, so a match holds until
  // the store's finalized tip moves; a mismatch is read again next time.
  private async aheadFault(
    node: RpcNode,
    reader: ElectionReader,
    finalized: L2BlockId,
  ): Promise<string | undefined> {
    const match = this.finalizedMatches.get(node.url);
    if (match !== undefined && sameBlock(match, finalized)) {
      return undefined;
    }
    const hash = await reader.getBlockHash(finalized.number);
    if (hash !== finalized.hash) {
      return hash === undefined
        ? `has no block at the block stream's finalized height ${finalized.number}`
        : `has another block at the block stream's finalized height ${finalized.number}`;
    }
    this.finalizedMatches.set(node.url, finalized);
    return undefined;
  }

  // Proven blocks move back only on an L1 reorg, so a first tip at or above
  // the old listener's proven height removes at most the unproven blocks. The
  // floor holds until this version's own tip reaches it; a store of another
  // version means the API holds no block of this one.
  private async bootstrapFloor(
    storedProposed: number,
  ): Promise<number | undefined> {
    if (!this.floorLifted) {
      this.floorLifted = await this.deps.store.otherVersionStored();
    }
    if (this.floorLifted) {
      return undefined;
    }
    const floor = await this.deps.legacyProvenHeight();
    this.floorLifted = storedProposed >= floor;
    return this.floorLifted ? undefined : floor;
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
