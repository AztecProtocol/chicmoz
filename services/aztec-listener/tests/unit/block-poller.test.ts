import { type BlockHash } from "@aztec-labs/stdlib/block";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_INFO_POLL_INTERVAL_MS } from "../../src/environment.js";
import { StickySource } from "../../src/svcs/poller/network-client/block-stream-source.js";
import { ChainPublisher } from "../../src/svcs/poller/pollers/block_poller/chain-publisher.js";
import {
  currentChain,
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
} from "./support/chain.js";

const mocks = vi.hoisted(() => ({
  publishTipsIfDue: vi.fn(),
  storeProcessedProposedBlockHeight: vi.fn(),
  readLatestRollupVersion: vi.fn(),
  readGenesisBlockHash: vi.fn(),
  stores: [] as { version: number; genesis: unknown }[],
}));
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

  it("logs a failed send through the listener's logger and publishes no tips", async () => {
    const x = new FakeNode("x", prefix(main, 3));
    const { chain } = chainOver([x], () =>
      Promise.reject(new Error("broker down")),
    );

    await runPass(chain);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Error processing block stream .*broker down/s),
    );
    expect(mocks.publishTipsIfDue).not.toHaveBeenCalled();
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

    x.chain = prefix(main, 5);
    await runPass(chain);
    expect(mocks.publishTipsIfDue).toHaveBeenCalledTimes(1);
    expect(runProvenSideWork).toHaveBeenCalledTimes(1);
    expect((await chain.store.getL2Tips()).proposed.number).toBe(7);
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
