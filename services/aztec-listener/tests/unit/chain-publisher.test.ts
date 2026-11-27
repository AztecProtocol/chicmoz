import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import {
  type BlockHash,
  type L2Block,
  L2BlockStream,
} from "@aztec-labs/stdlib/block";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StickySource } from "../../src/svcs/poller/network-client/block-stream-source.js";
import { ChainPublisher } from "../../src/svcs/poller/pollers/block_poller/chain-publisher.js";
import {
  type Chain,
  FakeNode,
  ROLLUP_VERSION,
  blocksFrom,
  chainOf,
  emptyBlock,
  genesisChain,
  grow,
  memoryStore,
  prefix,
  readerOf,
  respond,
  tipsOf,
} from "./support/chain.js";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({ logger }));
vi.mock("../../src/events/emitted/index.js", () => ({
  onChainInfo: vi.fn(),
  onL2RpcNodeAlive: vi.fn(),
  onL2RpcNodeError: vi.fn(),
  onL2RpcNodeInfo: vi.fn(),
}));

let genesis: BlockHash;
let base: Chain;
let main: Chain;

beforeAll(async () => {
  base = await genesisChain();
  genesis = await base.blocks[0].hash();
  main = await grow(base, 20);
});

beforeEach(() => {
  vi.clearAllMocks();
});

type Sent = { block: number; hash: string; tip: number };

const setup = ({
  nodes,
  online = nodes,
  maxPruneDepth = 10,
}: {
  nodes: FakeNode[];
  online?: FakeNode[];
  maxPruneDepth?: number;
}) => {
  const store = memoryStore(genesis, () => true, 20);
  const clock = { now: 1_000_000 };
  const world = { online };
  const source = new StickySource(
    {
      store,
      legacyProvenHeight: () => Promise.resolve(0),
      nodes: () => world.online.map((f) => f.rpc),
      openReader: readerOf(nodes),
      now: () => clock.now,
    },
    { maxPruneDepth, waitAlertMs: 60_000 },
  );
  const sent: Sent[] = [];
  const lowered: number[] = [];
  const failing = new Set<number>();
  const publisher = new ChainPublisher(
    {
      rollupVersion: ROLLUP_VERSION,
      store,
      source,
      publishBlock: async (block: L2Block, tip: number) => {
        if (failing.delete(block.number)) {
          throw new Error("send rejected");
        }
        sent.push({
          block: block.number,
          hash: (await block.hash()).toString(),
          tip,
        });
      },
      lowerProvenCursor: (height) => {
        lowered.push(height);
        return Promise.resolve();
      },
      transaction: (fn) => fn(),
      now: () => clock.now,
    },
    { maxPruneDepth, prefixAlertMs: 60_000 },
  );
  /** One listener pass: the election, then the stream when a node is pinned. */
  const pass = async (startingBlock?: number) => {
    const pinned = await source.elect();
    if (pinned !== undefined) {
      publisher.startPass();
      await new L2BlockStream(source, source.localData, publisher, undefined, {
        batchSize: 10,
        startingBlock,
      }).sync();
      publisher.finishPass();
    }
    return pinned;
  };
  const head = async () => (await store.getL2Tips()).proposed;
  return { store, source, clock, world, sent, lowered, failing, pass, head };
};

const sentOf = (chain: Chain, heights: number[], tip: number): Sent[] =>
  heights.map((n) => ({ block: n, hash: chain.hashes[n], tip }));

const loggedTimes = (log: typeof logger.warn, text: string) =>
  log.mock.calls.filter(([message]) => String(message).includes(text)).length;

describe("ChainPublisher after the node replaces published heights", () => {
  // The node drops heights 6-7 of the stored chain and serves chain `b` from 6.
  it.each([
    {
      regrowth: "to 6, then to 7 on the next pass",
      tips: [6, 7],
      expected: [
        [[6], 6],
        [[7], 7],
      ] as [number[], number][],
    },
    {
      regrowth: "to 8, past the stored tip",
      tips: [8],
      expected: [[[6, 7, 8], 8]] as [number[], number][],
    },
    {
      regrowth: "to 7, the stored tip's height",
      tips: [7],
      expected: [[[6, 7], 7]] as [number[], number][],
    },
  ])(
    "publishes the replacing blocks, each with its pass's tip, when the chain regrows $regrowth",
    async ({ tips, expected }) => {
      const x = new FakeNode("x", prefix(main, 7));
      const { sent, lowered, pass, head } = setup({ nodes: [x] });
      await pass();
      sent.length = 0;
      const b = await grow(prefix(main, 5), 8);

      for (const tip of tips) {
        x.chain = prefix(b, tip);
        await pass();
      }

      expect(sent).toEqual(
        expected.flatMap(([heights, tip]) => sentOf(b, heights, tip)),
      );
      expect(lowered).toEqual([5]);
      const top = tips[tips.length - 1];
      expect(await head()).toEqual({ number: top, hash: b.hashes[top] });
    },
  );

  it("stops the pass at a failed send, and the next pass sends again from that block", async () => {
    const x = new FakeNode("x", prefix(main, 5));
    const { sent, failing, pass, head } = setup({ nodes: [x] });
    await pass();
    sent.length = 0;
    x.chain = prefix(main, 9);

    failing.add(7);
    await pass();
    expect(sent).toEqual(sentOf(main, [6], 9));
    expect((await head()).number).toBe(6);

    await pass();
    expect(sent).toEqual([
      ...sentOf(main, [6], 9),
      ...sentOf(main, [7, 8, 9], 9),
    ]);
  });
});

describe("ChainPublisher checks", () => {
  it("ends the pass on a node with only a shorter copy of the stored chain, unpins it, and alerts while every pass does", async () => {
    const x = new FakeNode("x", prefix(main, 7));
    const { source, clock, sent, lowered, pass, head } = setup({ nodes: [x] });
    await pass();
    sent.length = 0;
    x.chain = prefix(main, 5);
    const waiting = "waits for a node at or past its tip";

    expect(await pass()).toBe(x.rpc);
    expect(source.pinned).toBeUndefined();
    clock.now += 60_000;
    await pass();
    await pass();

    expect(sent).toEqual([]);
    expect(lowered).toEqual([]);
    expect(await head()).toEqual({ number: 7, hash: main.hashes[7] });
    expect(loggedTimes(logger.warn, waiting)).toBe(1);
    expect(loggedTimes(logger.error, waiting)).toBe(1);

    // A pass that does not end on the rule ends the wait.
    x.chain = prefix(main, 7);
    await pass();
    x.chain = prefix(main, 5);
    await pass();
    expect(loggedTimes(logger.warn, waiting)).toBe(2);
  });

  it("stores nothing and moves no cursor on a prune deeper than the guard", async () => {
    const x = new FakeNode("x", prefix(main, 8));
    const { sent, lowered, pass, head } = setup({
      nodes: [x],
      maxPruneDepth: 2,
    });
    await pass();
    sent.length = 0;
    // Depth 3: one past the guard, and within the walk bound.
    x.chain = await grow(prefix(main, 5), 9);

    await pass();

    expect(sent).toEqual([]);
    expect(lowered).toEqual([]);
    expect(await head()).toEqual({ number: 8, hash: main.hashes[8] });
    expect(loggedTimes(logger.error, "past AZTEC_MAX_PRUNE_DEPTH 2")).toBe(1);
  });

  it.each([
    {
      fault: "sends a batch with a broken link",
      reason: "sent block 8, which does not extend block 7",
      arrange: async (x: FakeNode) => {
        x.chain = await chainOf([
          ...main.blocks.slice(0, 8),
          await emptyBlock(8),
        ]);
      },
    },
    {
      fault: "sends a batch unlinked to the store",
      reason: "sent block 7, which does not extend block 6",
      arrange: async (x: FakeNode) => {
        const fork = await grow(prefix(main, 5), 9);
        x.chain = prefix(main, 9);
        x.getBlocksOverride = (from, limit) =>
          blocksFrom(
            fork,
            [...Array(limit).keys()].map((i) => from + i),
          );
      },
    },
    {
      fault: "changes the block below a batch",
      reason: "has another block 6 than the one the block stream stored",
      arrange: async (x: FakeNode) => {
        const fork = await grow(prefix(main, 5), 6);
        x.chain = prefix(main, 9);
        // The walk-back reads block 6 first, the batch's parent check second.
        let readsAt6 = 0;
        x.getBlockOverride = (param) => {
          const n = (param as { number: number }).number;
          const served = n === 6 && ++readsAt6 === 2 ? fork : main;
          return respond(served.blocks[n], false);
        };
      },
    },
    {
      fault: "sends a block of another rollup version",
      reason: `sent block 7 of rollup version ${ROLLUP_VERSION + 1}`,
      arrange: async (x: FakeNode) => {
        x.chain = await chainOf([
          ...main.blocks.slice(0, 7),
          await emptyBlock(7, main.blocks[6], ROLLUP_VERSION + 1),
        ]);
      },
    },
    {
      fault: "forks below the stored finalized tip",
      reason: "asks to prune to block 6",
      arrange: async (x: FakeNode, pass: () => Promise<unknown>) => {
        x.chain = prefix(main, 8);
        await pass();
        // Its probe shows the stored chain; its pass serves a fork from block 5.
        const fork = await grow(prefix(main, 4), 9);
        x.chain = prefix(main, 9);
        x.servedChain = fork;
        x.chainTipsOverride = () => ({
          ...tipsOf(fork, { checkpointed: 6, proven: 6, finalized: 6 }),
          finalized: x.tips().finalized,
        });
      },
    },
  ])(
    "publishes nothing and sets the node aside when it $fault",
    async ({ reason, arrange }) => {
      const x = new FakeNode("x", prefix(main, 6));
      x.tiers = { checkpointed: 6, proven: 6, finalized: 6 };
      const y = new FakeNode("y", prefix(main, 6));
      y.tiers = x.tiers;
      const { store, world, sent, lowered, pass } = setup({
        nodes: [x, y],
        online: [x],
      });
      await pass();
      await arrange(x, pass);
      sent.length = 0;
      const before = await store.getL2Tips();

      expect(await pass()).toBe(x.rpc);
      expect(sent).toEqual([]);
      expect(lowered).toEqual([]);
      expect(await store.getL2Tips()).toEqual(before);
      world.online = [x, y];
      expect(await pass()).toBe(y.rpc);
      expect(loggedTimes(logger.warn, "sits out the block stream")).toBe(1);
      expect(loggedTimes(logger.warn, reason)).toBe(1);
    },
  );

  it("stores no proposed tip that the pass did not send", async () => {
    const x = new FakeNode("x", prefix(main, 4));
    x.tiers = { checkpointed: 4, proven: 4, finalized: 4 };
    const { sent, pass, head } = setup({ nodes: [x] });

    // Past the node's tip: the stream downloads nothing and reports the tip.
    expect(await pass(6)).toBe(x.rpc);

    expect(sent).toEqual([]);
    expect((await head()).number).toBe(0);
    expect(loggedTimes(logger.warn, "which this pass did not send")).toBe(1);
  });

  it("refuses a prune to block 0 through heights the store holds no hash for", async () => {
    const x = new FakeNode("x", await grow(base, 12));
    const { store, sent, lowered, pass } = setup({ nodes: [x] });
    // A first pass from block 10 that stopped before its tier events.
    await store.handleBlockStreamEvent({
      type: "blocks-added",
      blocks: main.blocks.slice(10, 12),
    });
    const before = await store.getL2Tips();

    expect(await pass()).toBe(x.rpc);

    expect(sent).toEqual([]);
    expect(lowered).toEqual([]);
    expect(await store.getL2Tips()).toEqual(before);
    expect(loggedTimes(logger.error, "asks to prune to block 0")).toBe(1);
  });

  it.each([
    {
      fault: "a proven tip off the stored chain",
      reason: "has another block at its proven height 6",
      tips: () => {
        const tips = tipsOf(prefix(main, 10), {
          checkpointed: 10,
          proven: 6,
          finalized: 4,
        });
        return {
          ...tips,
          proven: {
            ...tips.proven,
            block: { number: BlockNumber(6), hash: main.hashes[5] },
          },
        };
      },
    },
    {
      fault: "tiers out of order",
      reason: "sent tips out of order",
      tips: () =>
        tipsOf(prefix(main, 10), { checkpointed: 5, proven: 6, finalized: 4 }),
    },
  ])(
    "stores no tier from a snapshot with $fault, sets the node aside, and follows an honest node",
    async ({ reason, tips }) => {
      const honest = new FakeNode("honest", prefix(main, 6));
      honest.tiers = { checkpointed: 6, proven: 4, finalized: 4 };
      const faulty = new FakeNode("faulty", prefix(main, 10));
      faulty.tiers = { checkpointed: 10, proven: 6, finalized: 4 };
      faulty.chainTipsOverride = tips;
      const { store, world, pass } = setup({
        nodes: [honest, faulty],
        online: [honest],
      });
      await pass();

      world.online = [faulty];
      expect(await pass()).toBe(faulty.rpc);
      expect((await store.getL2Tips()).proven.block.number).toBe(4);
      expect(loggedTimes(logger.warn, reason)).toBe(1);

      honest.chain = prefix(main, 10);
      honest.tiers = { checkpointed: 10, proven: 6, finalized: 4 };
      world.online = [faulty, honest];
      expect(await pass()).toBe(honest.rpc);
      expect((await store.getL2Tips()).proven.block).toEqual({
        number: 6,
        hash: main.hashes[6],
      });
    },
  );

  // The node forks from block 5, below the stored proven tip 6 and above the
  // stored finalized tip 4.
  it.each([
    {
      fault: "another block 4 as its proven tip",
      reason: "has another block at its proven height 4",
      tiers: { checkpointed: 9, proven: 4, finalized: 4 },
      provenHash: () => main.hashes[3],
    },
    {
      fault: "tiers out of order",
      reason: "sent tips out of order",
      tiers: { checkpointed: 6, proven: 7, finalized: 4 },
      provenHash: undefined,
    },
  ])(
    "stores nothing from a prune with $fault, sets the node aside, and follows an honest node",
    async ({ reason, tiers, provenHash }) => {
      const x = new FakeNode("x", prefix(main, 8));
      x.tiers = { checkpointed: 8, proven: 6, finalized: 4 };
      const y = new FakeNode("y", prefix(main, 8));
      y.tiers = x.tiers;
      const { store, world, sent, lowered, pass } = setup({
        nodes: [x, y],
        online: [x],
      });
      await pass();
      sent.length = 0;
      const fork = await grow(prefix(main, 5), 9);
      x.chain = fork;
      x.chainTipsOverride = () => {
        const tips = tipsOf(fork, tiers);
        return provenHash === undefined
          ? tips
          : {
              ...tips,
              proven: {
                ...tips.proven,
                block: { ...tips.proven.block, hash: provenHash() },
              },
            };
      };
      const before = await store.getL2Tips();

      expect(await pass()).toBe(x.rpc);
      expect(sent).toEqual([]);
      expect(lowered).toEqual([]);
      expect(await store.getL2Tips()).toEqual(before);
      expect(loggedTimes(logger.warn, reason)).toBe(1);
      world.online = [x, y];
      expect(await pass()).toBe(y.rpc);
    },
  );

  it.each([
    {
      change: "a prune past a proof",
      arrange: async (x: FakeNode) => {
        x.chain = await grow(prefix(main, 6), 9);
        x.tiers = { checkpointed: 9, proven: 5, finalized: 4 };
      },
    },
    {
      change: "a proof that moves back",
      arrange: (x: FakeNode) => {
        x.tiers = { checkpointed: 8, proven: 5, finalized: 4 };
        return Promise.resolve();
      },
    },
  ])(
    "moves the proven cursor back to the new proven tip on $change",
    async ({ arrange }) => {
      const x = new FakeNode("x", prefix(main, 8));
      x.tiers = { checkpointed: 8, proven: 6, finalized: 4 };
      const { store, lowered, pass } = setup({ nodes: [x] });
      await pass();
      await arrange(x);

      await pass();

      expect(lowered).toEqual([5]);
      expect((await store.getL2Tips()).proven.block.number).toBe(5);
    },
  );
});
