import { type BlockHash } from "@aztec-labs/stdlib/block";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_INFO_POLL_INTERVAL_MS } from "../../src/environment.js";
import { StickySource } from "../../src/svcs/poller/network-client/block-stream-source.js";
import { ChainPublisher } from "../../src/svcs/poller/pollers/block_poller/chain-publisher.js";
import {
  currentChain,
  pollOnce,
  runPass,
  streamRollupVersion,
} from "../../src/svcs/poller/pollers/block_poller/index.js";
import { runProvenSideWork } from "../../src/svcs/poller/pollers/block_poller/proven-side-work.js";
import {
  type Chain,
  FakeNode,
  ROLLUP_VERSION,
  genesisChain,
  grow,
  memoryStore,
  prefix,
  readerOf,
  respond,
  tipsOf,
} from "./support/chain.js";

const mocks = vi.hoisted(() => {
  const heights = { processedProposedBlockHeight: 0 };
  return {
    heights,
    publishTipsIfDue: vi.fn(),
    storeProcessedProposedBlockHeight: vi.fn((height: number) => {
      heights.processedProposedBlockHeight = height;
      return Promise.resolve();
    }),
    readLatestRollupVersion: vi.fn(),
    readGenesisBlockHash: vi.fn(),
    stores: [] as { version: number; genesis: unknown }[],
  };
});
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({ logger }));
vi.mock("../../src/events/emitted/index.js", () => ({
  onCatchupBlock: vi.fn(),
  onChainInfo: vi.fn(),
  onL2RpcNodeAlive: vi.fn(),
  onL2RpcNodeError: vi.fn(),
  onL2RpcNodeInfo: vi.fn(),
  onOrderedBlock: vi.fn(),
}));
vi.mock("../../src/svcs/poller/pollers/l2-tips-poller.js", () => ({
  publishTipsIfDue: mocks.publishTipsIfDue,
}));
vi.mock("../../src/svcs/database/heights.controller.js", () => ({
  getBlockHeights: () =>
    Promise.resolve({
      processedProposedBlockHeight: mocks.heights.processedProposedBlockHeight,
      processedProvenBlockHeight: 0,
      chainProvenBlockHeight: 0,
    }),
  lowerProcessedProvenBlockHeight: vi.fn(),
  storeProcessedProposedBlockHeight: mocks.storeProcessedProposedBlockHeight,
  storeProcessedProvenBlockHeight: vi.fn(),
}));
vi.mock("../../src/svcs/database/l2-tips-store.js", () => ({
  PostgresL2TipsStore: class {
    constructor(version: number, genesis: unknown) {
      mocks.stores.push({ version, genesis });
    }
  },
}));
vi.mock(
  "../../src/svcs/poller/pollers/block_poller/proven-side-work.js",
  () => ({
    runProvenSideWork: vi.fn(),
  }),
);
vi.mock("../../src/svcs/poller/network-client/rollup-version.js", () => ({
  readLatestRollupVersion: mocks.readLatestRollupVersion,
}));
vi.mock(
  "../../src/svcs/poller/network-client/block-stream-source.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/svcs/poller/network-client/block-stream-source.js")
    >()),
    readGenesisBlockHash: mocks.readGenesisBlockHash,
  }),
);

let main: Chain;
let genesis: BlockHash;

beforeAll(async () => {
  main = await grow(await genesisChain(), 10);
  genesis = await main.blocks[0].hash();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.heights.processedProposedBlockHeight = 0;
});

const chainOver = (
  nodes: FakeNode[],
  send: () => Promise<void> = () => Promise.resolve(),
) => {
  const sent: number[] = [];
  const store = memoryStore(genesis, () => true, 20);
  const source = new StickySource({
    store,
    legacyProvenHeight: () => Promise.resolve(0),
    nodes: () => nodes.map((n) => n.rpc),
    openReader: readerOf(nodes),
  });
  const publisher = new ChainPublisher({
    rollupVersion: ROLLUP_VERSION,
    store,
    source,
    publishBlock: async (block) => {
      await send();
      sent.push(block.number);
    },
    lowerProvenCursor: () => Promise.resolve(),
    transaction: (fn) => fn(),
  });
  return {
    chain: { rollupVersion: ROLLUP_VERSION, store, source, publisher },
    sent,
  };
};

describe("block poller pass", () => {
  it("starts an empty store at the elected node's finalized block", async () => {
    const x = new FakeNode("x", prefix(main, 9));
    x.tiers = { checkpointed: 9, proven: 7, finalized: 6 };
    const { chain, sent } = chainOver([x]);

    await runPass(chain);

    expect(sent).toEqual([6, 7, 8, 9]);
    expect((await chain.store.getL2Tips()).finalized.block.number).toBe(6);
  });

  it("starts an empty store at the finalized block of the stream's own snapshot when it lags the election's", async () => {
    const x = new FakeNode("x", prefix(main, 4));
    x.tiers = { checkpointed: 4, proven: 3, finalized: 3 };
    // The election's probe reached a backend further ahead.
    x.probeTipsOverride = () =>
      tipsOf(prefix(main, 9), { checkpointed: 9, proven: 7, finalized: 6 });
    const { chain, sent } = chainOver([x]);

    await runPass(chain);

    expect(sent).toEqual([3, 4]);
    expect((await chain.store.getL2Tips()).proposed).toEqual({
      number: 4,
      hash: main.hashes[4],
    });
  });

  it("fails the pass on a failed send, before any post-pass work", async () => {
    const x = new FakeNode("x", prefix(main, 3));
    const { chain } = chainOver([x], () =>
      Promise.reject(new Error("broker down")),
    );

    await expect(runPass(chain)).rejects.toThrow("broker down");

    expect(mocks.publishTipsIfDue).not.toHaveBeenCalled();
    expect(runProvenSideWork).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("redacts URLs in a failed pass's log, its error's cause too, and keeps its stack frames", async () => {
    const x = new FakeNode("x", prefix(main, 3));
    const { chain } = chainOver([x]);
    await runPass(chain);
    x.chain = prefix(main, 5);
    const url = "https://user:secret@node.example/v1/key123?apikey=key456";
    const failure = new Error(`Error fetching from host ${url}: fetch failed`, {
      cause: new Error(`connect ECONNREFUSED ${url}`),
    });
    // Node prints an ES module's frames as file URLs.
    failure.stack = `Error: ${failure.message}\n    at read (file:///app/build/client.js:1:2)`;
    // The walk-back reads block 3 first, the batch's parent check second.
    let readsAt3 = 0;
    x.getBlockOverride = (param) => {
      const n = (param as { number: number }).number;
      return n === 3 && ++readsAt3 >= 2
        ? Promise.reject(failure)
        : respond(x.chain.blocks[n], false);
    };

    await pollOnce(() => Promise.resolve(chain));

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [line] = logger.error.mock.calls[0] as [string];
    expect(line).toContain(
      "🐻 block stream pass failed: Error: Error fetching from host <url>: fetch failed\n    at read (file:///app/build/client.js:1:2)",
    );
    expect(line).toContain("[cause]: Error: connect ECONNREFUSED <url>");
    expect(line).not.toMatch(/secret|key123|key456|node\.example/);
  });

  it("publishes the snapshot's tips after a pass that reaches them, and no tips or side work after one that ends on the prefix rule", async () => {
    const x = new FakeNode("x", prefix(main, 7));
    const { chain } = chainOver([x]);

    await runPass(chain);
    expect(mocks.publishTipsIfDue).toHaveBeenCalledTimes(1);
    expect(mocks.publishTipsIfDue.mock.calls[0][0]).toMatchObject({
      proposed: { number: 7, hash: main.hashes[7] },
    });
    expect(mocks.storeProcessedProposedBlockHeight).toHaveBeenCalledWith(7);
    expect(runProvenSideWork).toHaveBeenCalledTimes(1);
    const [deps] = vi.mocked(runProvenSideWork).mock.calls[0];
    expect(deps).toMatchObject({
      rollupVersion: ROLLUP_VERSION,
      provenTip: 0,
      finalizedTip: 0,
    });
    expect(await deps.storedHash(7)).toBe(main.hashes[7]);

    x.chain = prefix(main, 5);
    await runPass(chain);
    expect(mocks.publishTipsIfDue).toHaveBeenCalledTimes(1);
    expect(runProvenSideWork).toHaveBeenCalledTimes(1);
    expect((await chain.store.getL2Tips()).proposed.number).toBe(7);
  });

  it("writes the legacy proposed height whenever it differs from the store's tip, moved or not", async () => {
    const x = new FakeNode("x", prefix(main, 7));
    const { chain } = chainOver([x]);
    await runPass(chain);
    await runPass(chain);
    expect(mocks.storeProcessedProposedBlockHeight.mock.calls).toEqual([[7]]);

    // As a pass that failed after storing blocks leaves it.
    mocks.heights.processedProposedBlockHeight = 5;
    await runPass(chain);

    expect(mocks.storeProcessedProposedBlockHeight.mock.calls).toEqual([
      [7],
      [7],
    ]);
  });

  it("starts a new store, from the reporting node's block 0, when node info reports a new rollup version", async () => {
    const [a, b] = [new FakeNode("a", main), new FakeNode("b", main)];
    mocks.readLatestRollupVersion
      .mockResolvedValueOnce({ node: a.rpc, version: 1 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ node: b.rpc, version: 2 });
    mocks.readGenesisBlockHash.mockImplementation(
      ({ name }: { name: string }) => Promise.resolve(`block 0 of ${name}`),
    );

    const first = await currentChain(0);
    // No read within the interval, and a read no node answers keeps the version.
    expect(await currentChain(CHAIN_INFO_POLL_INTERVAL_MS - 1)).toBe(first);
    expect(await currentChain(CHAIN_INFO_POLL_INTERVAL_MS)).toBe(first);
    const second = await currentChain(2 * CHAIN_INFO_POLL_INTERVAL_MS);

    expect(mocks.readLatestRollupVersion).toHaveBeenCalledTimes(3);
    expect(mocks.stores).toEqual([
      { version: 1, genesis: "block 0 of a" },
      { version: 2, genesis: "block 0 of b" },
    ]);
    expect(second.rollupVersion).toBe(2);
    expect(streamRollupVersion()).toBe(2);
  });
});
