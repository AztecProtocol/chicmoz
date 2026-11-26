import {
  BlockNumber,
  CheckpointNumber,
} from "@aztec-labs/foundation/branded-types";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { type AztecNode } from "@aztec-labs/aztec.js/node";
import {
  type BlockHash,
  type BlockParameter,
  L2Block,
  type L2Tips,
  L2TipsMemoryStore,
} from "@aztec-labs/stdlib/block";
import { type BlockResponse } from "@aztec-labs/stdlib/interfaces/client";
import { vi } from "vitest";
import { type OpenElectionReader } from "../../../src/svcs/poller/network-client/election-probe.js";
import { type RpcNode } from "../../../src/svcs/poller/network-client/pool.js";

export const ROLLUP_VERSION = 7;

export type Chain = { blocks: L2Block[]; hashes: string[] };

// An empty body's tx effects root is zero, so these blocks pass the body check.
export const emptyBlock = (
  n: number,
  parent?: L2Block,
  version = ROLLUP_VERSION,
) =>
  L2Block.random(BlockNumber(n), {
    txsPerBlock: 0,
    txEffectsTreeRoot: Fr.ZERO,
    version: new Fr(version),
    ...(parent === undefined ? {} : { lastArchive: parent.archive }),
  });

export const chainOf = async (blocks: L2Block[]): Promise<Chain> => ({
  blocks,
  hashes: await Promise.all(
    blocks.map(async (b) => (await b.hash()).toString()),
  ),
});

/** `chain` extended to height `to`, each new block linked to the one below. */
export const grow = async (chain: Chain, to: number): Promise<Chain> => {
  const blocks = [...chain.blocks];
  for (let n = blocks.length; n <= to; n++) {
    blocks.push(await emptyBlock(n, blocks.at(-1)));
  }
  return chainOf(blocks);
};

export const prefix = (chain: Chain, to: number): Chain => ({
  blocks: chain.blocks.slice(0, to + 1),
  hashes: chain.hashes.slice(0, to + 1),
});

export const genesisChain = async (): Promise<Chain> =>
  chainOf([await emptyBlock(0)]);

export const respond = async (
  block: L2Block,
  withBody: boolean,
): Promise<BlockResponse> => ({
  header: block.header,
  archive: block.archive,
  hash: await block.hash(),
  checkpointNumber: block.checkpointNumber,
  indexWithinCheckpoint: block.indexWithinCheckpoint,
  number: block.number,
  ...(withBody ? { body: block.body } : {}),
});

export const blocksFrom = (chain: Chain, heights: number[]) =>
  Promise.all(heights.map((n) => respond(chain.blocks[n], true)));

export const checkpointHash = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}`;

/** The parts of an Aztec node the stream source and the election read. */
export class FakeNode {
  readonly rpc: RpcNode;
  tiers = { checkpointed: 0, proven: 0, finalized: 0 };
  unreachable = false;
  probes = 0;
  headerReads = 0;
  readonly calls: string[] = [];
  /** Answers the pass's tips reads only; the election's probe still sees `tips()`. */
  chainTipsOverride?: () => L2Tips | undefined;
  /** Answers the election's probe only. */
  probeTipsOverride?: () => L2Tips;
  /** Serves the pass's block reads in place of `chain`. */
  servedChain?: Chain;
  getBlocksOverride?: (
    from: number,
    limit: number,
  ) => Promise<BlockResponse[] | undefined>;
  getBlockOverride?: (
    param: BlockParameter,
  ) => Promise<BlockResponse | undefined>;

  constructor(
    name: string,
    public chain: Chain,
  ) {
    this.rpc = {
      name,
      url: `http://${name}.invalid`,
      instance: this as unknown as AztecNode,
    };
  }

  get tip() {
    return this.chain.blocks.length - 1;
  }

  tips(): L2Tips {
    const id = (n: number) => ({
      number: BlockNumber(n),
      hash: this.chain.hashes[n],
    });
    const tier = (n: number) => ({
      block: id(n),
      checkpoint: { number: CheckpointNumber(n), hash: checkpointHash(n) },
    });
    return {
      proposed: id(this.tip),
      checkpointed: tier(this.tiers.checkpointed),
      proven: tier(this.tiers.proven),
      finalized: tier(this.tiers.finalized),
    };
  }

  getChainTips() {
    this.calls.push("getChainTips");
    return Promise.resolve(
      this.chainTipsOverride === undefined
        ? this.tips()
        : this.chainTipsOverride(),
    );
  }

  getBlock(param: BlockParameter): Promise<BlockResponse | undefined> {
    this.calls.push("getBlock");
    if (this.getBlockOverride !== undefined) {
      return this.getBlockOverride(param);
    }
    const chain = this.servedChain ?? this.chain;
    const height =
      typeof param === "number"
        ? param
        : typeof param === "object" && "number" in param
          ? param.number
          : typeof param === "object" && "hash" in param
            ? chain.hashes.indexOf(param.hash.toString())
            : -1;
    if (height < 0 || height >= chain.blocks.length) {
      return Promise.resolve(undefined);
    }
    return respond(chain.blocks[height], false);
  }

  getBlocks(from: number, limit: number): Promise<BlockResponse[] | undefined> {
    this.calls.push("getBlocks");
    if (this.getBlocksOverride !== undefined) {
      return this.getBlocksOverride(from, limit);
    }
    return Promise.all(
      (this.servedChain ?? this.chain).blocks
        .slice(from, from + limit)
        .map((block) => respond(block, true)),
    );
  }
}

export const tipsOf = (chain: Chain, tiers: FakeNode["tiers"]) => {
  const view = new FakeNode("view", chain);
  view.tiers = tiers;
  return view.tips();
};

/** Runs `work` while `node`'s next block range hangs, until the pinned read's deadline ends it. */
export const pastDeadline = async <T>(
  node: FakeNode,
  work: () => Promise<T>,
) => {
  let reached: () => void = () => undefined;
  const hanging = new Promise<void>((resolve) => {
    reached = resolve;
  });
  node.getBlocksOverride = () => {
    reached();
    return new Promise<never>(() => undefined);
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const running = work();
    await hanging;
    await vi.advanceTimersByTimeAsync(60_000);
    return await running;
  } finally {
    vi.useRealTimers();
  }
};

export const readerOf =
  (fakes: FakeNode[]): OpenElectionReader =>
  (node) => {
    const fake = fakes.find((f) => f.rpc.url === node.url);
    if (fake === undefined) {
      throw new Error(`no fake node ${node.name}`);
    }
    return {
      getChainTips: () => {
        fake.probes++;
        return fake.unreachable
          ? Promise.reject(new Error("connection refused"))
          : Promise.resolve(fake.probeTipsOverride?.() ?? fake.tips());
      },
      getBlockHash: (n) => {
        fake.headerReads++;
        return Promise.resolve(fake.chain.hashes.at(n));
      },
    };
  };

/** The SDK's memory store with the Postgres store's two extra reads, over heights up to `top`. */
export const memoryStore = (
  genesis: BlockHash,
  otherVersionStored: () => boolean,
  top: number,
) => {
  const memory = new L2TipsMemoryStore(genesis);
  return Object.assign(memory, {
    otherVersionStored: () => Promise.resolve(otherVersionStored()),
    holdsHashAtOrAbove: async (height: number) => {
      for (let n = Math.max(height, 1); n <= top; n++) {
        if ((await memory.getL2BlockHash(BlockNumber(n))) !== undefined) {
          return true;
        }
      }
      return false;
    },
  });
};
