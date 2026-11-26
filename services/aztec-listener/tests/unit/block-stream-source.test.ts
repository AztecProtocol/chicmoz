import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import {
  BlockNumber,
  CheckpointNumber,
} from "@aztec-labs/foundation/branded-types";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { AbortError, TimeoutError } from "@aztec-labs/foundation/error";
import { type AztecNode } from "@aztec-labs/aztec.js/node";
import {
  type BlockHash,
  type BlockParameter,
  L2Block,
  type L2BlockStreamEventHandler,
  type L2BlockStreamLocalDataProvider,
  L2BlockStream,
  type L2Tips,
  L2TipsMemoryStore,
} from "@aztec-labs/stdlib/block";
import { type BlockResponse } from "@aztec-labs/stdlib/interfaces/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeCheckError,
  StickySource,
  readGenesisBlockHash,
} from "../../src/svcs/poller/network-client/block-stream-source.js";
import {
  type OpenElectionReader,
  boundedElectionReaders,
} from "../../src/svcs/poller/network-client/election-probe.js";
import { type RpcNode } from "../../src/svcs/poller/network-client/pool.js";

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

type Chain = { blocks: L2Block[]; hashes: string[] };

// An empty body's tx effects root is zero, so these blocks pass the body check.
const emptyBlock = (n: number) =>
  L2Block.random(BlockNumber(n), {
    txsPerBlock: 0,
    txEffectsTreeRoot: Fr.ZERO,
  });

const grow = async (chain: Chain, to: number): Promise<Chain> => {
  const blocks = [...chain.blocks];
  for (let n = blocks.length; n <= to; n++) {
    blocks.push(await emptyBlock(n));
  }
  const hashes = await Promise.all(
    blocks.map(async (b) => (await b.hash()).toString()),
  );
  return { blocks, hashes };
};

const prefix = (chain: Chain, to: number): Chain => ({
  blocks: chain.blocks.slice(0, to + 1),
  hashes: chain.hashes.slice(0, to + 1),
});

const respond = async (
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

const blocksFrom = (chain: Chain, heights: number[]) =>
  Promise.all(heights.map((n) => respond(chain.blocks[n], true)));

const checkpointHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** The parts of an Aztec node the stream source and the election read. */
class FakeNode {
  readonly rpc: RpcNode;
  tiers = { checkpointed: 0, proven: 0, finalized: 0 };
  unreachable = false;
  probes = 0;
  headerReads = 0;
  readonly calls: string[] = [];
  /** Answers the pass's tips reads only; the election's probe still sees `tips()`. */
  chainTipsOverride?: () => L2Tips;
  /** Answers the election's probe only. */
  probeTipsOverride?: () => L2Tips;
  getBlocksOverride?: (from: number, limit: number) => Promise<BlockResponse[]>;
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
    return Promise.resolve(this.chainTipsOverride?.() ?? this.tips());
  }

  getBlock(param: BlockParameter): Promise<BlockResponse | undefined> {
    this.calls.push("getBlock");
    if (this.getBlockOverride !== undefined) {
      return this.getBlockOverride(param);
    }
    const height =
      typeof param === "number"
        ? param
        : typeof param === "object" && "number" in param
          ? param.number
          : typeof param === "object" && "hash" in param
            ? this.chain.hashes.indexOf(param.hash.toString())
            : -1;
    if (height < 0 || height > this.tip) {
      return Promise.resolve(undefined);
    }
    return respond(this.chain.blocks[height], false);
  }

  getBlocks(from: number, limit: number): Promise<BlockResponse[]> {
    this.calls.push("getBlocks");
    if (this.getBlocksOverride !== undefined) {
      return this.getBlocksOverride(from, limit);
    }
    return Promise.all(
      this.chain.blocks
        .slice(from, from + limit)
        .map((block) => respond(block, true)),
    );
  }
}

const tipsOf = (chain: Chain, tiers: FakeNode["tiers"]) => {
  const view = new FakeNode("view", chain);
  view.tiers = tiers;
  return view.tips();
};

/** Runs `work` while `node`'s next block range hangs, until the pinned read's deadline ends it. */
const pastDeadline = async <T>(node: FakeNode, work: () => Promise<T>) => {
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

const readerOf =
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

let genesis: BlockHash;
let base: Chain;
let main: Chain;

beforeAll(async () => {
  const block0 = await emptyBlock(0);
  genesis = await block0.hash();
  base = { blocks: [block0], hashes: [genesis.toString()] };
  main = await grow(base, 12);
});

beforeEach(() => {
  vi.clearAllMocks();
});

type Setup = {
  nodes: FakeNode[];
  online?: FakeNode[];
  maxPruneDepth?: number;
  legacyProvenHeight?: number;
  otherVersionStored?: () => boolean;
};

type Pass = () => Promise<RpcNode | undefined>;

/** The SDK's memory store with the Postgres store's two extra reads. */
const testStore = (otherVersionStored: () => boolean) => {
  const memory = new L2TipsMemoryStore(genesis);
  return Object.assign(memory, {
    otherVersionStored: () => Promise.resolve(otherVersionStored()),
    holdsHashAtOrAbove: async (height: number) => {
      for (let n = Math.max(height, 1); n < main.blocks.length; n++) {
        if ((await memory.getL2BlockHash(BlockNumber(n))) !== undefined) {
          return true;
        }
      }
      return false;
    },
  });
};

const setup = ({
  nodes,
  online = nodes,
  maxPruneDepth = 10,
  legacyProvenHeight = 0,
  otherVersionStored = () => true,
}: Setup) => {
  const store = testStore(otherVersionStored);
  const clock = { now: 1_000_000 };
  const world = { online };
  /** A source over the same store, as after a restart. */
  const fresh = () =>
    new StickySource(
      {
        store,
        legacyProvenHeight: () => Promise.resolve(legacyProvenHeight),
        nodes: () => world.online.map((f) => f.rpc),
        openReader: readerOf(nodes),
        now: () => clock.now,
      },
      { maxPruneDepth, waitAlertMs: 60_000 },
    );
  const source = fresh();
  const streamWith = (
    handler: L2BlockStreamEventHandler = store,
    localData: L2BlockStreamLocalDataProvider = source.localData,
  ) =>
    new L2BlockStream(source, localData, handler, undefined, {
      batchSize: 10,
    });
  const stream = streamWith();
  /** One listener pass: the election, then the stream when a node is pinned. */
  const pass = async (s = stream) => {
    const pinned = await source.elect();
    if (pinned !== undefined) {
      await s.sync();
    }
    return pinned;
  };
  return { store, source, clock, world, stream, streamWith, pass, fresh };
};

/** A JSON-RPC server on an OS-assigned port; `reply` gets each request's ids. */
const serve = async (reply: (res: ServerResponse, ids: number[]) => void) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const ids = (JSON.parse(body) as { id: number }[]).map(({ id }) => id);
      res.writeHead(200, { "content-type": "application/json" });
      reply(res, ids);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const fallbackWarnings = () =>
  logger.warn.mock.calls.filter(([message]) =>
    String(message).includes("behind on proofs"),
  ).length;

/** A node whose pass leaves the store finalized at block 4 of `main`. */
const finalizedAtFour = () => {
  const node = new FakeNode("honest", prefix(main, 6));
  node.tiers = { checkpointed: 6, proven: 4, finalized: 4 };
  return node;
};

describe("StickySource election", () => {
  it("keeps the pin until a node is more than 2 blocks ahead, so a stalled node loses it, and starts on the most advanced node", async () => {
    const a = new FakeNode("a", prefix(main, 5));
    const b = new FakeNode("b", prefix(main, 9));
    const c = new FakeNode("c", prefix(main, 7));
    const { source } = setup({ nodes: [a, b, c] });

    expect(await source.elect()).toBe(b.rpc);
    a.chain = prefix(main, 11);
    expect(await source.elect()).toBe(b.rpc);
    a.chain = prefix(main, 12);
    expect(await source.elect()).toBe(a.rpc);
  });

  it("never elects a node behind on finality or with another block at the store's finalized height, so the store's finalized tip never moves back", async () => {
    const honest = finalizedAtFour();
    const behind = new FakeNode("behind", prefix(main, 9));
    behind.tiers = { checkpointed: 9, proven: 3, finalized: 3 };
    // Finalized at or ahead of the store, on chains that left ours below block 4.
    const twin = new FakeNode("twin", await grow(prefix(main, 3), 10));
    twin.tiers = { checkpointed: 10, proven: 4, finalized: 4 };
    const forked = new FakeNode("forked", await grow(prefix(main, 2), 10));
    forked.tiers = { checkpointed: 10, proven: 6, finalized: 6 };
    const { store, source, world, pass } = setup({
      nodes: [behind, twin, forked, honest],
      online: [honest],
    });
    await pass();
    expect((await store.getL2Tips()).finalized.block.number).toBe(4);

    world.online = [behind, twin, forked, honest];
    expect(await source.elect()).toBe(honest.rpc);
    expect(await source.elect()).toBe(honest.rpc);

    world.online = [behind, twin, forked];
    expect(await pass()).toBeUndefined();
    expect((await store.getL2Tips()).finalized.block).toEqual({
      number: 4,
      hash: main.hashes[4],
    });
  });

  it("elects a node that had another block at the store's finalized height once it serves the store's block", async () => {
    const honest = finalizedAtFour();
    const x = new FakeNode("x", await grow(prefix(main, 2), 10));
    x.tiers = { checkpointed: 10, proven: 6, finalized: 6 };
    const { source, world, pass } = setup({
      nodes: [honest, x],
      online: [honest],
    });
    await pass();

    world.online = [x];
    expect(await source.elect()).toBeUndefined();
    x.chain = prefix(main, 10);
    expect(await source.elect()).toBe(x.rpc);
    // The match holds until the store's finalized tip moves.
    expect(await source.elect()).toBe(x.rpc);
    expect(x.headerReads).toBe(2);
  });

  it("compares the hash at the store's finalized height on every election, and drops a cached match that a snapshot contradicts", async () => {
    const honest = finalizedAtFour();
    const x = new FakeNode("x", prefix(main, 10));
    x.tiers = { checkpointed: 10, proven: 6, finalized: 6 };
    const { source, world, pass } = setup({
      nodes: [honest, x],
      online: [honest],
    });
    await pass();

    world.online = [x];
    expect(await source.elect()).toBe(x.rpc);
    // Another backend behind the same URL, finalized at the store's height on another block.
    x.chain = await grow(prefix(main, 3), 10);
    x.tiers = { checkpointed: 10, proven: 4, finalized: 4 };
    expect(await source.elect()).toBeUndefined();
    // Then finalized past the store on that chain.
    x.tiers = { checkpointed: 10, proven: 6, finalized: 6 };
    expect(await source.elect()).toBeUndefined();
    expect(x.headerReads).toBe(2);
  });

  it("prefers nodes at or above the store's proven tip, and warns once when it has to follow nodes behind on proofs", async () => {
    const p = new FakeNode("p", prefix(main, 7));
    p.tiers = { checkpointed: 7, proven: 5, finalized: 3 };
    const x = new FakeNode("x", prefix(main, 9));
    x.tiers = { checkpointed: 9, proven: 4, finalized: 3 };
    const y = new FakeNode("y", prefix(main, 7));
    y.tiers = { checkpointed: 7, proven: 5, finalized: 3 };
    const q = new FakeNode("q", prefix(main, 7));
    q.tiers = { checkpointed: 7, proven: 4, finalized: 3 };
    const r = new FakeNode("r", prefix(main, 8));
    r.tiers = { checkpointed: 8, proven: 4, finalized: 3 };
    const { source, world, pass } = setup({
      nodes: [p, x, y, q, r],
      online: [p],
    });
    await pass();

    // x is ahead but behind on proofs; y is not.
    world.online = [x, y];
    expect(await source.elect()).toBe(y.rpc);
    expect(fallbackWarnings()).toBe(0);

    // x behind on finality, y behind on proofs: y, with one warning.
    x.tiers = { checkpointed: 9, proven: 6, finalized: 2 };
    y.tiers = { checkpointed: 7, proven: 4, finalized: 3 };
    expect(await source.elect()).toBe(y.rpc);
    expect(fallbackWarnings()).toBe(1);

    // The pinned node is lost, and every other node is behind on proofs.
    logger.warn.mockClear();
    y.unreachable = true;
    world.online = [y, q, r];
    expect(await source.elect()).toBe(r.rpc);
    expect(fallbackWarnings()).toBe(1);
  });

  it("waits at the first start while every node is below the old listener's proven height, and alerts while it waits", async () => {
    const a = new FakeNode("a", prefix(main, 7));
    const b = new FakeNode("b", prefix(main, 9));
    let stored = false;
    const { source, clock, world } = setup({
      nodes: [a, b],
      legacyProvenHeight: 10,
      otherVersionStored: () => stored,
    });

    expect(await source.elect()).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    clock.now += 60_000;
    expect(await source.elect()).toBeUndefined();
    clock.now += 1_000;
    expect(await source.elect()).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);

    b.chain = prefix(main, 10);
    expect(await source.elect()).toBe(b.rpc);

    // A store of another rollup version lifts the floor.
    stored = true;
    world.online = [a];
    expect(await source.elect()).toBe(a.rpc);
  });

  it("keeps the floor after a restart while the stream has stored only blocks below it", async () => {
    const a = new FakeNode("a", prefix(main, 12));
    const b = new FakeNode("b", prefix(main, 9));
    const { store, world, pass, fresh } = setup({
      nodes: [a, b],
      online: [a],
      legacyProvenHeight: 10,
      otherVersionStored: () => false,
    });
    // The first pass stores blocks below the floor, then loses its node.
    a.getBlocksOverride = (from) =>
      from === 1
        ? blocksFrom(main, [1, 2, 3, 4, 5])
        : Promise.reject(new Error("connection reset"));
    expect(await pass()).toBe(a.rpc);
    expect((await store.getL2Tips()).proposed.number).toBe(5);

    world.online = [b];
    expect(await fresh().elect()).toBeUndefined();
  });

  it("lifts the floor after a restart once the stream has crossed it, a prune below it since included", async () => {
    const a = new FakeNode("a", prefix(main, 12));
    const b = new FakeNode("b", prefix(main, 9));
    const { store, world, pass, fresh } = setup({
      nodes: [a, b],
      online: [a],
      legacyProvenHeight: 10,
      otherVersionStored: () => false,
    });
    await pass();
    // A chain that left ours after block 6 and ends below the floor.
    a.chain = await grow(prefix(main, 6), 8);
    expect(await pass()).toBe(a.rpc);
    expect((await store.getL2Tips()).proposed).toEqual({
      number: 8,
      hash: a.chain.hashes[8],
    });
    expect(await store.getL2BlockHash(BlockNumber(10))).toBe(main.hashes[10]);

    world.online = [b];
    expect(await fresh().elect()).toBe(b.rpc);
  });

  it("leaves out a node that drips its tips past the deadline or sends more than 64 KiB, and follows another", async () => {
    const tips = {
      proposed: { number: 3, hash: main.hashes[3] },
      ...Object.fromEntries(
        ["checkpointed", "proven", "finalized"].map((tier) => [
          tier,
          {
            block: { number: 0, hash: genesis.toString() },
            checkpoint: { number: 0, hash: checkpointHash(0) },
          },
        ]),
      ),
    };
    const answer = (ids: number[]) =>
      JSON.stringify(ids.map((id) => ({ jsonrpc: "2.0", id, result: tips })));
    const servers = await Promise.all([
      serve((res) => {
        res.write("[");
        const drip = setInterval(() => res.write(" "), 50);
        res.on("close", () => clearInterval(drip));
      }),
      serve((res, ids) => res.end(" ".repeat(70 * 1024) + answer(ids))),
      serve((res, ids) => res.end(answer(ids))),
    ]);
    try {
      const [slow, big, good] = servers.map(({ url }, i) => ({
        name: ["slow", "big", "good"][i],
        url,
        instance: {} as AztecNode,
      }));
      const source = new StickySource({
        store: testStore(() => true),
        legacyProvenHeight: () => Promise.resolve(0),
        nodes: () => [slow, big, good],
        openReader: boundedElectionReaders(300),
      });

      const started = Date.now();
      expect(await source.elect()).toBe(good);
      expect(Date.now() - started).toBeLessThan(1_500);
      const sitOut = logger.warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) =>
          message.includes("left out of the block stream elections"),
        );
      expect(sitOut).toHaveLength(2);
      expect(sitOut).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Node slow"),
          expect.stringContaining("Node big"),
        ]),
      );
    } finally {
      await Promise.all(servers.map(({ close }) => close()));
    }
  });

  it("logs a node's election fault once until its kind changes, and once when the node is eligible again", async () => {
    const honest = finalizedAtFour();
    const x = new FakeNode("x", prefix(main, 9));
    x.tiers = { checkpointed: 9, proven: 3, finalized: 3 };
    const { source, world, pass } = setup({
      nodes: [honest, x],
      online: [honest],
    });
    await pass();
    world.online = [honest, x];
    const aboutX = (log: typeof logger.warn) =>
      log.mock.calls.filter(([message]) =>
        String(message).startsWith("Node x "),
      );

    await source.elect();
    x.tiers = { checkpointed: 9, proven: 2, finalized: 2 };
    await source.elect();
    expect(aboutX(logger.warn)).toHaveLength(1);
    x.unreachable = true;
    await source.elect();
    expect(aboutX(logger.warn)).toHaveLength(2);

    x.unreachable = false;
    x.tiers = { checkpointed: 9, proven: 4, finalized: 4 };
    await source.elect();
    await source.elect();
    expect(aboutX(logger.warn)).toHaveLength(2);
    expect(aboutX(logger.info)).toHaveLength(1);
  });
});

describe("StickySource passes", () => {
  it("re-reads only the pinned node when the walk-back reads the tips again", async () => {
    const x = new FakeNode("x", prefix(main, 5));
    const y = new FakeNode("y", prefix(main, 5));
    const { store, source, pass } = setup({ nodes: [x, y] });
    await pass();

    const replacing = await grow(prefix(main, 3), 5);
    x.chain = replacing;
    y.chain = replacing;
    expect(await source.elect()).toBe(x.rpc);
    // Far enough ahead to win an election inside the pass, were there one.
    y.chain = await grow(replacing, 9);
    x.calls.length = 0;
    y.calls.length = 0;
    const probes = y.probes;
    await new L2BlockStream(source, source.localData, store, undefined, {
      batchSize: 10,
    }).sync();

    expect(x.calls.filter((c) => c === "getChainTips")).toHaveLength(2);
    expect(y.calls).toEqual([]);
    expect(y.probes).toBe(probes);
    expect(source.pinned).toBe(x.rpc);
    expect(await store.getL2BlockHash(BlockNumber(4))).toBe(
      replacing.hashes[4],
    );
  });

  it("skips the pass when the pinned node's snapshot fails the election's checks, the post-walk one too", async () => {
    // A restarted node, finalized below what its probe showed.
    const x = finalizedAtFour();
    const { store, source, stream, pass } = setup({ nodes: [x] });
    await pass();
    const synced = await store.getL2Tips();
    x.chain = prefix(main, 8);
    expect(await source.elect()).toBe(x.rpc);
    x.tiers = { checkpointed: 8, proven: 3, finalized: 3 };
    await stream.sync();
    expect(await store.getL2Tips()).toEqual(synced);
    expect(source.lastError).toBeInstanceOf(AbortError);

    // Below the floor on the snapshot the stream reads after its walk-back.
    const y = new FakeNode("y", await grow(prefix(main, 4), 9));
    const floored = setup({
      nodes: [y],
      legacyProvenHeight: 8,
      otherVersionStored: () => false,
    });
    await floored.store.handleBlockStreamEvent({
      type: "blocks-added",
      blocks: main.blocks.slice(1, 6),
    });
    const partial = await floored.store.getL2Tips();
    const low = new FakeNode("low", prefix(y.chain, 6)).tips();
    let snapshots = 0;
    y.chainTipsOverride = () => (++snapshots === 2 ? low : y.tips());
    expect(await floored.pass()).toBe(y.rpc);
    expect(snapshots).toBe(2);
    expect(await floored.store.getL2Tips()).toEqual(partial);
  });

  it("skips the pass when the pinned node's snapshot is finalized past the store on another chain, after a probe that needed no read", async () => {
    const x = finalizedAtFour();
    const { store, source, pass } = setup({ nodes: [x] });
    await pass();
    const synced = await store.getL2Tips();
    x.headerReads = 0;

    // The probe reaches a backend finalized at the store's block; the pass,
    // one on a chain that left ours below block 4.
    x.probeTipsOverride = () =>
      tipsOf(prefix(main, 8), { checkpointed: 8, proven: 4, finalized: 4 });
    x.chain = await grow(prefix(main, 2), 10);
    x.tiers = { checkpointed: 10, proven: 6, finalized: 6 };
    expect(await pass()).toBe(x.rpc);

    expect(x.headerReads).toBe(0);
    expect(source.lastError).toBeInstanceOf(AbortError);
    expect(await store.getL2Tips()).toEqual(synced);
  });

  it("follows the node with the replacing block within three passes while two tied nodes have only a shorter copy", async () => {
    const a = new FakeNode("a", prefix(main, 6));
    const b = new FakeNode("b", prefix(main, 6));
    const c = new FakeNode("c", prefix(main, 6));
    const { store, source, streamWith, pass } = setup({ nodes: [a, b, c] });
    await pass();
    // Stands in for the publisher's prefix rule.
    const publisher: L2BlockStreamEventHandler = {
      handleBlockStreamEvent: async (event) => {
        if (
          event.type === "chain-pruned" &&
          event.block.number === source.lastTips?.proposed.number
        ) {
          source.endPassOnPrefix();
          throw new AbortError();
        }
        await store.handleBlockStreamEvent(event);
      },
    };
    const stream = streamWith(publisher);

    a.chain = prefix(main, 5);
    b.chain = prefix(main, 5);
    c.chain = await grow(prefix(main, 4), 5);
    const elected = [
      await pass(stream),
      await pass(stream),
      await pass(stream),
    ];
    expect(elected).toEqual([a.rpc, b.rpc, c.rpc]);
    expect((await store.getL2Tips()).proposed).toEqual({
      number: 5,
      hash: c.chain.hashes[5],
    });
  });

  it.each([
    {
      failure: "times out",
      fail: (x: FakeNode, run: Pass) => pastDeadline(x, run),
    },
    {
      failure: "fails a read",
      fail: (x: FakeNode, run: Pass) => {
        x.getBlocksOverride = () => Promise.reject(new Error("internal error"));
        return run();
      },
    },
    {
      failure: "sends a snapshot the checks reject",
      fail: (x: FakeNode, run: Pass) => {
        x.chainTipsOverride = () =>
          tipsOf(x.chain, { checkpointed: 12, proven: 3, finalized: 3 });
        return run();
      },
    },
  ])(
    "elects a healthy node within two passes while the node ahead $failure on every pass, and lets a benched node back once its tip changes",
    async ({ fail }) => {
      const x = new FakeNode("x", prefix(main, 12));
      x.tiers = { checkpointed: 12, proven: 4, finalized: 4 };
      const y = new FakeNode("y", prefix(main, 6));
      y.tiers = { checkpointed: 6, proven: 4, finalized: 4 };
      const { store, world, pass } = setup({ nodes: [x, y], online: [y] });
      await pass();
      world.online = [x, y];
      y.chain = prefix(main, 8);

      expect(await fail(x, pass)).toBe(x.rpc);
      expect(await pass()).toBe(y.rpc);
      expect((await store.getL2Tips()).proposed.number).toBe(8);

      // Tips ahead of the blocks it serves.
      y.chain = prefix(main, 10);
      y.getBlocksOverride = () => Promise.resolve([]);
      expect(await pass()).toBe(y.rpc);
      y.chain = prefix(main, 11);
      y.getBlocksOverride = undefined;
      expect(await pass()).toBe(y.rpc);
      expect((await store.getL2Tips()).proposed.number).toBe(11);
    },
  );

  it("follows a node that pruned between its tips and its blocks on the next pass, without setting it aside", async () => {
    const x = new FakeNode("x", prefix(main, 5));
    const { store, source, pass } = setup({ nodes: [x] });
    await pass();
    const pruned = await grow(prefix(main, 3), 4);
    x.chain = prefix(main, 6);
    x.getBlocksOverride = () => {
      x.chain = pruned;
      x.getBlocksOverride = undefined;
      return Promise.resolve([]);
    };

    expect(await pass()).toBe(x.rpc);
    expect((await store.getL2Tips()).proposed.number).toBe(5);
    expect(source.lastError).toBeUndefined();
    expect(await pass()).toBe(x.rpc);
    expect((await store.getL2Tips()).proposed).toEqual({
      number: 4,
      hash: pruned.hashes[4],
    });
  });

  it.each([
    {
      fault: "a range starts below the height asked",
      arrange: (x: FakeNode) => {
        x.getBlocksOverride = () => blocksFrom(main, [2, 3]);
      },
      read: (s: StickySource) =>
        s.getBlocks({ from: BlockNumber(3), limit: 2 }),
    },
    {
      fault: "a range skips a height",
      arrange: (x: FakeNode) => {
        x.getBlocksOverride = () => blocksFrom(main, [3, 5]);
      },
      read: (s: StickySource) =>
        s.getBlocks({ from: BlockNumber(3), limit: 3 }),
    },
    {
      fault: "a range is longer than its limit",
      arrange: (x: FakeNode) => {
        x.getBlocksOverride = () => blocksFrom(main, [3, 4, 5]);
      },
      read: (s: StickySource) =>
        s.getBlocks({ from: BlockNumber(3), limit: 2 }),
    },
    {
      fault: "a body does not match its header",
      arrange: (x: FakeNode) => {
        x.getBlocksOverride = async () => [
          await respond(
            await L2Block.random(BlockNumber(3), { txsPerBlock: 1 }),
            true,
          ),
        ];
      },
      read: (s: StickySource) =>
        s.getBlocks({ from: BlockNumber(3), limit: 1 }),
    },
    {
      fault: "a header read answers another height",
      arrange: (x: FakeNode) => {
        x.getBlockOverride = () => respond(main.blocks[4], false);
      },
      read: (s: StickySource) => s.getBlockData({ number: BlockNumber(3) }),
    },
  ])(
    "fails the pass and sits the node out when $fault",
    async ({ arrange, read }) => {
      const x = new FakeNode("x", prefix(main, 5));
      const y = new FakeNode("y", prefix(main, 5));
      const { source } = setup({ nodes: [x, y] });
      expect(await source.elect()).toBe(x.rpc);
      await source.getL2Tips();
      arrange(x);

      await expect(read(source)).rejects.toBeInstanceOf(NodeCheckError);
      expect(source.lastError).toBeInstanceOf(NodeCheckError);
      expect(source.pinned).toBeUndefined();
      expect(await source.elect()).toBe(y.rpc);
    },
  );

  it("aborts a walk-back past the bound on block reads and sits the node out", async () => {
    const x = new FakeNode("x", prefix(main, 8));
    const { store, source, streamWith, pass } = setup({
      nodes: [x],
      maxPruneDepth: 2,
    });
    await pass();
    const before = await store.getL2Tips();

    // Disagrees with every stored hash down to genesis. Reading the store
    // directly leaves only the block-read bound in play.
    x.chain = await grow(base, 8);
    x.calls.length = 0;
    await pass(streamWith(store, store));

    expect(await store.getL2Tips()).toEqual(before);
    expect(source.lastError).toBeInstanceOf(NodeCheckError);
    expect(x.calls.filter((c) => c === "getBlock")).toHaveLength(2 + 2);
    expect(await source.elect()).toBeUndefined();
  });

  it("aborts a walk-back past the bound through heights the store has no hash for", async () => {
    const x = new FakeNode("x", prefix(main, 4));
    const { store, source, pass } = setup({ nodes: [x], maxPruneDepth: 2 });
    // An interrupted first pass from block 10: no hash below it, finalized still 0.
    await store.handleBlockStreamEvent({
      type: "blocks-added",
      blocks: main.blocks.slice(10, 12),
    });
    const before = await store.getL2Tips();

    await pass();

    expect(await store.getL2Tips()).toEqual(before);
    expect(source.lastError).toBeInstanceOf(NodeCheckError);
    expect(x.calls.filter((c) => c === "getBlock")).toHaveLength(2);
    expect(await source.elect()).toBeUndefined();
  });

  it("fails the pass when a pinned read outlasts its deadline, and keeps the node electable", async () => {
    const x = new FakeNode("x", prefix(main, 5));
    const { store, source, pass } = setup({ nodes: [x] });
    await pass();
    x.chain = prefix(main, 8);

    await pastDeadline(x, pass);
    expect(source.lastError).toBeInstanceOf(TimeoutError);
    expect((await store.getL2Tips()).proposed.number).toBe(5);

    x.getBlocksOverride = undefined;
    expect(await pass()).toBe(x.rpc);
    expect((await store.getL2Tips()).proposed.number).toBe(8);
  });

  it("reads the genesis hash from block 0, and stops when a node does not serve it", async () => {
    const x = new FakeNode("x", prefix(main, 2));
    expect((await readGenesisBlockHash(x.rpc)).toString()).toBe(
      genesis.toString(),
    );

    x.getBlockOverride = () => Promise.resolve(undefined);
    await expect(readGenesisBlockHash(x.rpc)).rejects.toThrow(
      "does not serve block 0",
    );
  });
});
