import { setTimeout as sleep } from "node:timers/promises";
import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import { chicmozL2BlockLightSchema } from "@chicmoz-pkg/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brokerReads } from "./broker.js";
import { readPruneEndpoints } from "./endpoints.js";
import {
  type BlockRef,
  type ReorgRecord,
  byRoot,
  explorerReads,
  plusReorg,
  served,
  settle,
} from "./explorer-reads.js";
import {
  type ChainWatch,
  type ForcedPrune,
  forceEpochPrune,
  readNodeChain,
  watchChain,
} from "./force-prune.js";
import { pruneOrder, readTipReads } from "./rpc-tap.js";
import { type Sender, openSender } from "./send-tx.js";
import { type WsClient, type WsFrame, connectWs } from "./ws-client.js";

const endpoints = readPruneEndpoints();
const node = createAztecNodeClient(endpoints.aztecNodeUrl);
const api = explorerReads(endpoints.explorerApiUrl);
const broker = brokerReads(endpoints.broker);

// For the API to reach what a scenario expects once the node's chain is
// final, which a correct pipeline does in a few polls; it bounds the commit
// wait too.
const SETTLE_TIMEOUT_MS = 30_000;
// Longer than the API's 5 s block cache.
const CACHE_MS = 6_000;
// A listener pass that read the node just before the prune may publish
// just after it.
const PREFIX_GRACE_MS = 3_000;
// 15 of the listener's block polls, and longer than its tips cadence (a 5 s
// poll and the 5 s heartbeat set here), so today's tips timer shows.
const PREFIX_WAIT_MS = 15_000;
// A pass reads the tip and the next starts a poll interval after it ends:
// four intervals between two reads leave three for a pass, so a longer gap
// means the listener stopped reading the node.
const LISTENER_READ_GAP_MS = 4 * endpoints.listenerPollMs;

const t0 = Date.now();
const log = (line: string) =>
  process.stdout.write(
    `[prune +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}\n`,
  );

type Deployed = { txHash: string; address: string };
type Receipt = { status: string; blockNumber?: number; blockHash?: string };

const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

const receiptOf = async (txHash: string): Promise<Receipt> => {
  const r = await node.getTxReceipt(TxHash.fromString(txHash));
  return {
    status: String(r.status),
    blockNumber:
      r.blockNumber === undefined ? undefined : Number(r.blockNumber),
    blockHash: r.blockHash?.toString().toLowerCase(),
  };
};

/** Each tx's receipt once it is in a block of the node's current chain. */
const minedOnChain = async (txs: Deployed[]) => {
  const receipts = new Map<string, Receipt>();
  await vi.waitFor(
    async () => {
      const chain = await readNodeChain(node);
      for (const { txHash } of txs) {
        const r = await receiptOf(txHash);
        expect(
          r.blockNumber !== undefined &&
            chain.get(r.blockNumber) === r.blockHash,
          `tx ${txHash} in a block of the node's chain: ${JSON.stringify(r)}`,
        ).toBe(true);
        receipts.set(txHash, r);
      }
    },
    { timeout: 90_000, interval: 500 },
  );
  return receipts;
};

const blockOf = (r: Receipt): BlockRef => ({
  height: r.blockNumber ?? -1,
  hash: r.blockHash ?? "",
});

const deadOf = (prune: ForcedPrune): BlockRef[] =>
  prune.removed.map((height) => ({
    height,
    hash: prune.before.get(height) ?? "",
  }));

/** Waits until the API serves `hashes` at `heights` as canonical. */
const apiHolds = (heights: number[], hashes: Map<number, string>) =>
  vi.waitFor(
    async () =>
      expect(
        await Promise.all(heights.map(api.blockAt)),
        `the API at ${heights.join(",")}`,
      ).toEqual(
        heights.map((height) =>
          served({ height, hash: hashes.get(height) ?? "" }, false),
        ),
      ),
    { timeout: 60_000, interval: 1_000 },
  );

/**
 * Each scenario starts from an API that agrees with the node up to the
 * proven base, so it judges its own prune, not what an earlier one left.
 */
const baseHeld = (base: Map<number, string>) =>
  apiHolds([...base.keys()], base);

/** The node's block at each height, or a 404 above its tip. */
const expectedChain = (heights: number[], chain: Map<number, string>) =>
  heights.map((height) => {
    const hash = chain.get(height);
    return hash === undefined
      ? { status: 404 }
      : served({ height, hash }, false);
  });

const outcome = async ({
  heights,
  txs,
  dead,
}: {
  heights: number[];
  txs: Deployed[];
  dead: BlockRef[];
}) => ({
  latestHeight: await api.latestHeight(),
  chain: await Promise.all(heights.map(api.blockAt)),
  reorgs: byRoot(await api.reorgs()),
  txs: await Promise.all(
    txs.map(async ({ txHash, address }) => ({
      txHash,
      dropped: await api.dropped(txHash),
      effect: await api.txEffect(txHash),
      contract: await api.contractInstance(address),
    })),
  ),
  dead: await Promise.all(dead.map((b) => api.blockAt(b.hash))),
});

type Outcome = Awaited<ReturnType<typeof outcome>>;

/** The API once it has consumed what the broker held when `want` was met or its time ran out; a consumer that never catches up fails the scenario. */
const settled = async (
  args: Parameters<typeof outcome>[0],
  want: Partial<Outcome>,
  label: string,
) => {
  const { value, met, held } = await settle(() => outcome(args), {
    want,
    timeoutMs: SETTLE_TIMEOUT_MS,
    intervalMs: 1_000,
    cacheMs: CACHE_MS,
    consumedThrough: broker.apiConsumedThrough,
  });
  log(
    `${label}: ${met ? "expected state reached" : `expected state not reached in ${SETTLE_TIMEOUT_MS / 1000} s`}; once consumed, ${held ? "as expected" : "not as expected"}`,
  );
  return value;
};

/** The one reorg a prune adds: rooted at its first removed height, counting every removed block. */
const reorgOf = (prune: ForcedPrune): ReorgRecord => ({
  height: prune.removed[0],
  nbrOfOrphanedBlocks: prune.removed.length,
  orphanedBlockHash: prune.before.get(prune.removed[0]) ?? "",
});

const summary = (prune: ForcedPrune) => ({
  target: prune.target,
  doomed: prune.doomed,
  removed: prune.removed,
  timings: prune.timings,
});

/** What the listener itself read of the prune, from its own node reads. */
const listenerOrder = (prune: ForcedPrune) =>
  pruneOrder(readTipReads(endpoints.rpcTapFile), {
    since: prune.at.warp,
    target: prune.target,
    before: prune.before,
  });

let sender: Sender;
let watch: ChainWatch;
let ws: WsClient;

beforeAll(async () => {
  ws = await connectWs(endpoints.wsUrl);
  sender = await openSender(node);
  await sender.publishAccountClass();
  log("account class published");
  watch = watchChain(node, log);
});

afterAll(async () => {
  await watch?.stop();
  await sender?.stop();
  ws?.close();
  await broker.close();
});

describe("a prune of blocks with txs, which the node mines again at once in a replacing block", () => {
  let genesisArchive: string;
  let firstParent: unknown;
  let prune: ForcedPrune;
  let txs: Deployed[] = [];
  let after: Map<string, Receipt>;
  let chain: Map<number, string>;
  let heights: number[];
  let want: Pick<Outcome, "latestHeight" | "chain" | "reorgs" | "txs" | "dead">;
  let seen: Outcome;

  beforeAll(async () => {
    log("replaced at once: start");
    // From the node: the local network's genesis is not the SDK's constant.
    const genesis = await node.getBlock(BlockNumber(0));
    if (!genesis) {
      throw new Error("the node does not serve block 0");
    }
    genesisArchive = genesis.archive.root.toString().toLowerCase();
    let before = new Map<string, Receipt>();
    prune = await forceEpochPrune({
      node,
      nodeUrl: endpoints.aztecNodeUrl,
      anvilUrl: endpoints.anvilUrl,
      log,
      sendTxs: async () => {
        txs = [await sender.deploy(), await sender.deploy()];
        before = await minedOnChain(txs);
      },
      emptyBlocks: 1,
      afterProve: baseHeld,
      expectReplacement: true,
      // The prune tests something only once the API holds what it removes,
      // the account contracts included.
      beforeTrigger: async (doomed, hashes) => {
        await apiHolds(range(1, Math.max(...doomed)), hashes);
        await vi.waitFor(
          async () =>
            expect(
              await Promise.all(
                txs.map((t) => api.contractInstance(t.address)),
              ),
              "the account contracts before the prune",
            ).toEqual(
              txs.map((t) => ({
                hash: before.get(t.txHash)?.blockHash,
                orphaned: false,
              })),
            ),
          { timeout: 30_000, interval: 1_000 },
        );
      },
    });
    after = await minedOnChain(txs);
    const unmoved = txs.filter(
      ({ txHash }) =>
        after.get(txHash)?.blockHash === before.get(txHash)?.blockHash,
    );
    if (unmoved.length > 0) {
      throw new Error(
        `the node kept ${unmoved.map((t) => t.txHash).join(",")} in its dead block`,
      );
    }
    heights = range(1, Math.max(...prune.before.keys()) + 1);
    // Final: every tx is in a block of the node's chain, and no other comes.
    chain = await readNodeChain(node);
    want = {
      latestHeight: Math.max(...chain.keys()),
      chain: expectedChain(heights, chain),
      reorgs: [reorgOf(prune)],
      txs: txs.map(({ txHash }) => {
        const block = served(
          blockOf(after.get(txHash) ?? { status: "" }),
          false,
        );
        return {
          txHash,
          dropped: { status: 404 },
          effect: block,
          contract: { hash: block.hash, orphaned: false },
        };
      }),
      dead: deadOf(prune).map((b) => served(b, true)),
    };
    seen = await settled(
      { heights, txs, dead: deadOf(prune) },
      want,
      "replaced at once",
    );
    const first = await api.get("/l2/blocks/1");
    firstParent =
      first.status === 200
        ? chicmozL2BlockLightSchema
            .parse(first.body)
            .header.lastArchive.root.toLowerCase()
        : { status: first.status };
    const listener = listenerOrder(prune);
    log(`replaced at once: listener order: ${listener.order}`);
    log(
      `replaced at once: end ${JSON.stringify({
        genesis: genesis.hash.toString(),
        ...summary(prune),
        listener,
        receipts: txs.map(({ txHash }) => ({
          txHash,
          before: before.get(txHash),
          after: after.get(txHash),
        })),
        nodeChain: Object.fromEntries(chain),
        seen,
      })}`,
    );
  });

  it("serves the node's chain from its genesis as canonical, and nothing above the node's tip", () => {
    expect.soft(seen.latestHeight, "latest height").toBe(want.latestHeight);
    expect
      .soft(seen.chain, "the canonical block at each height")
      .toEqual(want.chain);
    expect.soft(firstParent, "block 1's parent archive").toBe(genesisArchive);
  });

  it("lists one reorg: the removed blocks, from the first removed height", () => {
    expect(seen.reorgs).toEqual(want.reorgs);
  });

  it("keeps each moved tx mined, not dropped, with its effect and its account contract on the node's block", () => {
    for (const [i, tx] of seen.txs.entries()) {
      const wanted = want.txs[i];
      expect
        .soft(tx.dropped, `${tx.txHash}: dropped-tx lookup`)
        .toEqual(wanted.dropped);
      expect.soft(tx.effect, `${tx.txHash}: tx effect`).toEqual(wanted.effect);
      expect
        .soft(tx.contract, `${tx.txHash}: its account contract`)
        .toEqual(wanted.contract);
    }
  });

  it("serves each dead block by its hash, as orphaned", () => {
    expect(seen.dead).toEqual(want.dead);
  });
});

/**
 * Waits until the websocket publisher has relayed each doomed block and a
 * tips frame at the doomed tip sent after `since`, so no frame from before
 * the prune can land in the quiet window.
 */
const framesArrived = (
  doomed: number[],
  hashes: Map<number, string>,
  since: number,
) =>
  vi.waitFor(
    () => {
      const tip = Math.max(...doomed);
      expect(
        doomed.filter(
          (h) =>
            !ws.frames.some(
              (f) => f.kind === "block" && f.hash === hashes.get(h),
            ),
        ),
        "doomed blocks the websocket has not relayed",
      ).toEqual([]);
      expect(
        ws.frames.some(
          (f) =>
            f.kind === "l2Tips" &&
            f.at >= since &&
            f.height === tip &&
            (f.hash === undefined || f.hash === hashes.get(tip)),
        ),
        `a tips frame at the doomed tip ${tip}`,
      ).toBe(true);
    },
    { timeout: 30_000, interval: 500 },
  );

describe("a prune of empty blocks, which leaves the node on the shorter chain until a tx comes", () => {
  let prune: ForcedPrune;
  let dead: BlockRef[];
  let quiet: WsFrame[];
  let kept: { start: unknown; end: unknown };
  let baseline: ReorgRecord[];
  let receipt: Receipt;
  let chain: Map<number, string>;
  let heights: number[];
  let want: Pick<Outcome, "chain" | "reorgs" | "dead">;
  let seen: Outcome;

  beforeAll(async () => {
    log("shorter chain: start");
    let provedAt = 0;
    prune = await forceEpochPrune({
      node,
      nodeUrl: endpoints.aztecNodeUrl,
      anvilUrl: endpoints.anvilUrl,
      log,
      sendTxs: () => Promise.resolve(),
      emptyBlocks: 2,
      afterProve: (base) => {
        provedAt = Date.now();
        return baseHeld(base);
      },
      expectReplacement: false,
      beforeTrigger: async (doomed, hashes) => {
        await apiHolds(doomed, hashes);
        await framesArrived(doomed, hashes, provedAt);
        baseline = await api.reorgList();
      },
    });
    dead = deadOf(prune);
    const view = async () => ({
      latestHeight: await api.latestHeight(),
      dead: await Promise.all(prune.doomed.map(api.blockAt)),
      reorgs: await api.reorgs(),
    });
    await sleep(PREFIX_GRACE_MS);
    const from = Date.now();
    const start = await view();
    await sleep(PREFIX_WAIT_MS);
    const end = await view();
    const to = Date.now();
    const moved = watch.events.filter((e) => e.at >= from);
    const tip = Number((await node.getChainTips()).proposed.number);
    if (moved.length > 0 || tip !== prune.target) {
      throw new Error(
        `the node left the shorter chain during the wait: tip ${tip}, ${JSON.stringify(moved)}`,
      );
    }
    // Silence counts only from an open socket and a listener still reading.
    if (ws.closedAt !== undefined && ws.closedAt <= to) {
      throw new Error(
        `the websocket closed ${ws.closedAt - from} ms into the wait`,
      );
    }
    const reads = readTipReads(endpoints.rpcTapFile).filter(
      (r) => r.proposed !== undefined && r.at >= from && r.at <= to,
    );
    const instants = [from, ...reads.map((r) => r.at), to];
    const longestGap = Math.max(
      ...instants.slice(1).map((t, i) => t - instants[i]),
    );
    if (longestGap > LISTENER_READ_GAP_MS) {
      throw new Error(
        `the listener read no tip for ${longestGap} ms of the wait (${reads.length} reads)`,
      );
    }
    quiet = ws.frames.filter((f) => f.at >= from && f.at <= to);
    kept = { start, end };

    const tx = await sender.deploy();
    receipt = (await minedOnChain([tx])).get(tx.txHash) ?? { status: "" };
    heights = range(prune.target + 1, Math.max(...prune.before.keys()) + 1);
    chain = await readNodeChain(node);
    want = {
      chain: expectedChain(heights, chain),
      reorgs: plusReorg(baseline, reorgOf(prune)),
      dead: dead.map((b) => served(b, true)),
    };
    seen = await settled({ heights, txs: [tx], dead }, want, "shorter chain");
    const listener = listenerOrder(prune);
    log(`shorter chain: listener order: ${listener.order}`);
    log(
      `shorter chain: end ${JSON.stringify({
        ...summary(prune),
        listener,
        waitMs: to - from,
        quiet,
        kept,
        receipt,
        nodeChain: Object.fromEntries(chain),
        seen,
      })}`,
    );
  });

  it("publishes no block and no tips while the node sits on the shorter chain", () => {
    expect
      .soft(
        quiet.filter((f) => f.kind === "block"),
        "block frames",
      )
      .toEqual([]);
    expect
      .soft(
        quiet.filter((f) => f.kind === "l2Tips"),
        "tips frames",
      )
      .toEqual([]);
  });

  it("keeps the dead blocks canonical while it waits", () => {
    expect
      .soft(kept.start, "at the start of the wait")
      .toMatchObject({ dead: dead.map((b) => served(b, false)) });
    expect.soft(kept.end, "at its end").toEqual(kept.start);
  });

  it("applies the prune once the node builds at the first pruned height", () => {
    expect
      .soft(receipt.blockNumber, "the new tx's block")
      .toBe(prune.removed[0]);
    expect
      .soft(seen.chain, "the canonical block above the target")
      .toEqual(want.chain);
    expect
      .soft(seen.reorgs, "every reorg: those before the prune, and one")
      .toEqual(want.reorgs);
    expect.soft(seen.dead, "the dead blocks by hash").toEqual(want.dead);
  });
});
