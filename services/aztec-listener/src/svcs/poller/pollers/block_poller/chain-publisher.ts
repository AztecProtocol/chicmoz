import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import {
  type L2Block,
  type L2BlockId,
  type L2BlockStreamEvent,
  type L2BlockStreamEventHandler,
  type L2Tips,
  type L2TipsStoreBase,
} from "@aztec-labs/stdlib/block";
import {
  AZTEC_MAX_PRUNE_DEPTH,
  AZTEC_STREAM_PREFIX_ALERT_MS,
} from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import {
  PassExit,
  type StickySource,
} from "../../network-client/block-stream-source.js";

type PruneEvent = Extract<L2BlockStreamEvent, { type: "chain-pruned" }>;
type ProposedEvent = Extract<L2BlockStreamEvent, { type: "chain-proposed" }>;
type TierEvent = Extract<
  L2BlockStreamEvent,
  { type: "chain-checkpointed" | "chain-proven" | "chain-finalized" }
>;
type Rejection = { reason: string; alert?: true };

export type ChainPublisherDeps = {
  rollupVersion: number;
  store: Pick<
    L2TipsStoreBase,
    "getL2Tips" | "getL2BlockHash" | "handleBlockStreamEvent"
  >;
  source: Pick<
    StickySource,
    | "pinned"
    | "lastTips"
    | "pinnedBlockData"
    | "pinnedBlockDataUnbenched"
    | "benchPinnedUntilNewTip"
    | "benchPinnedPastNextElection"
    | "setAsidePinned"
  >;
  /** Sends one block of the ordered stream; resolves once it is sent. */
  publishBlock: (block: L2Block, tip: number) => Promise<void>;
  /** Moves the proven side work's cursor back to a height; never forward. */
  lowerProvenCursor: (height: number) => Promise<void>;
  /** Runs `fn` in one listener transaction, which the store's writes join. */
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
};

export type ChainPublisherConfig = {
  maxPruneDepth: number;
  /** How long passes may end on the prefix rule before it alerts, and between alerts. */
  prefixAlertMs: number;
};

/** The block stream's handler: it stores a batch only once every block in it is sent. */
export class ChainPublisher implements L2BlockStreamEventHandler {
  private prefixWait: { since: number; alertedAt?: number } | undefined;
  private endedOnPrefix = false;
  private failure: Error | undefined;
  private readonly now: () => number;

  constructor(
    private readonly deps: ChainPublisherDeps,
    private readonly config: ChainPublisherConfig = {
      maxPruneDepth: AZTEC_MAX_PRUNE_DEPTH,
      prefixAlertMs: AZTEC_STREAM_PREFIX_ALERT_MS,
    },
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Call before each pass's `sync()`. */
  startPass(): void {
    this.endedOnPrefix = false;
    this.failure = undefined;
  }

  /**
   * Call after each pass's `sync()`, which resolves even when a handler
   * failed: this rethrows that failure. A pass that did not end on the prefix
   * rule ends the wait.
   */
  finishPass(): void {
    if (!this.endedOnPrefix) {
      this.prefixWait = undefined;
    }
    const failure = this.failure;
    this.failure = undefined;
    if (failure !== undefined) {
      throw failure;
    }
  }

  async handleBlockStreamEvent(event: L2BlockStreamEvent): Promise<void> {
    try {
      await this.handle(event);
    } catch (e) {
      if (e instanceof PassExit) {
        throw e;
      }
      // The stream would log it, or drop it for its AbortError name, and end
      // the pass; finishPass() rethrows it.
      const error = e instanceof Error ? e : new Error(String(e));
      this.failure ??= error;
      throw new PassExit(error.message, { cause: error });
    }
  }

  private handle(event: L2BlockStreamEvent): Promise<void> {
    switch (event.type) {
      case "blocks-added":
        return this.addBlocks(event.blocks);
      case "chain-pruned":
        return this.prune(event);
      case "chain-proposed":
        return this.confirmProposed(event);
      case "chain-checkpointed":
      case "chain-proven":
      case "chain-finalized":
        return this.moveTier(event);
      default:
        return this.deps.store.handleBlockStreamEvent(event);
    }
  }

  private async addBlocks(blocks: L2Block[]) {
    const tip = this.snapshot().proposed;
    const rejection = await this.batchFault(blocks);
    if (rejection !== undefined) {
      this.reject(rejection);
    }
    await this.confirmTip(tip, blocks);
    for (const block of blocks) {
      await this.deps.publishBlock(block, tip.number);
    }
    // The blocks sent so far carry this pass's tip, which the node may drop
    // before the next pass; storing none of them after a failed send makes
    // that pass send them again with its own tip.
    await this.deps.store.handleBlockStreamEvent({
      type: "blocks-added",
      blocks,
    });
  }

  private async batchFault(blocks: L2Block[]): Promise<Rejection | undefined> {
    const version = BigInt(this.deps.rollupVersion);
    for (const [i, block] of blocks.entries()) {
      const theirs = block.header.globalVariables.version.toBigInt();
      if (theirs !== version) {
        return {
          reason: `sent block ${block.number} of rollup version ${theirs}, not ${version}`,
          alert: true,
        };
      }
      const previous = blocks[i - 1];
      if (
        previous !== undefined &&
        !block.header.lastArchive.root.equals(previous.archive.root)
      ) {
        return {
          reason: `sent block ${block.number}, which does not extend block ${previous.number}`,
        };
      }
    }
    const first = blocks[0];
    const height = BlockNumber(first.number - 1);
    const stored = await this.deps.store.getL2BlockHash(height);
    if (stored === undefined) {
      // A first pass from `startingBlock` has no stored parent.
      return undefined;
    }
    // The store keeps hashes only; the link needs the parent's archive root.
    const parent = await this.deps.source.pinnedBlockData(height);
    if (parent === undefined) {
      throw new PassExit();
    }
    if ((await parent.header.hash()).toString() !== stored) {
      return {
        reason: `has another block ${height} than the one the block stream stored`,
      };
    }
    if (!first.header.lastArchive.root.equals(parent.archive.root)) {
      return {
        reason: `sent block ${first.number}, which does not extend block ${height}`,
      };
    }
    return undefined;
  }

  // The stream checks its snapshot's tip only after emitting every batch, yet
  // the API takes each block's tip as where the listener's chain ends. A node
  // that moved since its tips were read is not at fault, so a mismatch benches
  // it for the next election and until its tip changes, not for a cooldown.
  // The next pass then follows any other eligible node, which the sticky
  // election keeps while the benched node leads it by no more than the pin's lead.
  private async confirmTip(tip: L2BlockId, blocks: L2Block[]) {
    const last = blocks[blocks.length - 1];
    const held =
      last.number === tip.number
        ? last.hash()
        : this.deps.source
            .pinnedBlockDataUnbenched(tip.number)
            .then((data) => data?.header.hash());
    if ((await held)?.toString() !== tip.hash) {
      logger.warn(
        `Node ${this.pinnedName()} no longer holds this pass's proposed tip ${tip.number}; the pass ends before sending blocks ${blocks[0].number}-${last.number}`,
      );
      this.deps.source.benchPinnedPastNextElection();
      throw new PassExit();
    }
  }

  private async prune(event: PruneEvent) {
    const snapshot = this.snapshot();
    const target = event.block;
    const local = await this.deps.store.getL2Tips();
    if (target.number === snapshot.proposed.number) {
      // A real prune shows another block above the target; this node only
      // has a shorter copy of the stored chain.
      this.endedOnPrefix = true;
      this.notePrefixWait(target.number, local.proposed.number);
      this.deps.source.benchPinnedUntilNewTip();
      throw new PassExit();
    }
    const [atTarget, above] = await Promise.all([
      this.deps.store.getL2BlockHash(target.number),
      this.deps.store.getL2BlockHash(BlockNumber(target.number + 1)),
    ]);
    // The SDK ends a walk-back at the finalized tip on a disagreement, and
    // walks through heights the store holds no hash for.
    if (atTarget !== target.hash || above === undefined) {
      this.reject({
        reason: `asks to prune to block ${target.number}, which the block stream cannot confirm it holds`,
        alert: true,
      });
    }
    // The store writes each tier it lowers over the hash at that height, which
    // can be the finalized witness; at or below the target, no block of this
    // pass writes it back.
    for (const [tier, { block }] of [
      ["checkpointed", event.checkpointed],
      ["proven", event.proven],
    ] as const) {
      if (block.number <= target.number) {
        await this.checkStored(tier, block);
      }
    }
    const depth = local.proposed.number - target.number;
    if (depth > this.config.maxPruneDepth) {
      logger.error(
        `Node ${this.pinnedName()} asks to prune ${depth} blocks, past AZTEC_MAX_PRUNE_DEPTH ${this.config.maxPruneDepth}; the block stream stores nothing`,
      );
      throw new PassExit();
    }
    const provenBack = event.proven.block.number < local.proven.block.number;
    await this.deps.transaction(async () => {
      await this.deps.store.handleBlockStreamEvent(event);
      await this.deps.lowerProvenCursor(
        provenBack
          ? Math.min(target.number, event.proven.block.number)
          : target.number,
      );
    });
  }

  // The stream reports the snapshot's tip even when it downloaded nothing up
  // to it, as from a `startingBlock` past that tip. A valid pass has stored
  // that tip by now; a hash at its height alone can be a tier's, which a
  // prune writes before any block is sent.
  private async confirmProposed(event: ProposedEvent) {
    const { proposed } = await this.deps.store.getL2Tips();
    if (
      proposed.number !== event.block.number ||
      proposed.hash !== event.block.hash
    ) {
      logger.warn(
        `Node ${this.pinnedName()} has proposed tip ${event.block.number}, which this pass did not send; the pass ends`,
      );
      throw new PassExit();
    }
  }

  private async moveTier(event: TierEvent) {
    // The store writes a tier's hash over the one at its height, and the
    // finalized tier deletes the hashes below it.
    await this.checkStored(event.type.slice("chain-".length), event.block);
    if (event.type === "chain-proven") {
      const proven = (await this.deps.store.getL2Tips()).proven.block.number;
      if (event.block.number < proven) {
        await this.deps.transaction(async () => {
          await this.deps.store.handleBlockStreamEvent(event);
          await this.deps.lowerProvenCursor(event.block.number);
        });
        return;
      }
    }
    await this.deps.store.handleBlockStreamEvent(event);
  }

  private async checkStored(tier: string, block: L2BlockId) {
    if ((await this.deps.store.getL2BlockHash(block.number)) !== block.hash) {
      this.reject({
        reason: `has another block at its ${tier} height ${block.number} than the one the block stream stored`,
      });
    }
  }

  private snapshot(): L2Tips {
    const tips = this.deps.source.lastTips;
    if (tips === undefined) {
      throw new Error(
        "The block stream sent an event before the pass read the tips",
      );
    }
    return tips;
  }

  private reject({ reason, alert }: Rejection): never {
    const message = `Node ${this.pinnedName()} ${reason}`;
    if (alert) {
      logger.error(message);
    }
    this.deps.source.setAsidePinned(message);
    throw new PassExit(message);
  }

  private notePrefixWait(target: number, stored: number) {
    const now = this.now();
    const entering = this.prefixWait === undefined;
    this.prefixWait ??= { since: now };
    const message = `Node ${this.pinnedName()} is at block ${target}, below the block stream's tip ${stored} on its chain; the block stream waits for a node at or past its tip`;
    const { since, alertedAt } = this.prefixWait;
    if (now - (alertedAt ?? since) >= this.config.prefixAlertMs) {
      logger.error(`${message} (${Math.round((now - since) / 1000)}s so far)`);
      this.prefixWait.alertedAt = now;
    } else if (entering) {
      logger.warn(message);
    }
  }

  private pinnedName() {
    return this.deps.source.pinned?.name ?? "(none pinned)";
  }
}
