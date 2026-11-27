import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { brokerReads } from "./broker.js";
import {
  type HeightRange,
  checkRanges,
  firstMismatch,
} from "./compare-ranges.js";
import { readScriptedEndpoints } from "./endpoints.js";
import {
  type ReorgRecord,
  byRoot,
  explorerReads,
  plusReorg,
  served,
  settle,
} from "./explorer-reads.js";
import {
  type BlockId,
  type PruneFacts,
  type ScriptStatus,
  prefixHandled,
  scriptControl,
} from "./script-control.js";

const endpoints = readScriptedEndpoints();
const control = scriptControl(endpoints.controlUrl);
const api = explorerReads(endpoints.explorerApiUrl);
const broker = brokerReads(endpoints.broker);

afterAll(() => broker.close());

// Two of the listener's 1 s polls per state.
const STEP_MS = 2_000;
// For the API to reach what a scenario expects after its last step, which a
// correct pipeline does in a few polls; it bounds the commit wait too.
const SETTLE_TIMEOUT_MS = 30_000;
// Longer than the API's 5 s block cache.
const CACHE_MS = 6_000;

const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/** What the API serves of one prune, from height `from` to one past the node's tip. */
const snapshot = async (
  prune: PruneFacts,
  from: number,
  contractAddress?: string,
) => ({
  latestHeight: await api.latestHeight(),
  canonical: await Promise.all(
    range(from, prune.final.length + 1).map(api.blockAt),
  ),
  reorgs: byRoot(await api.reorgs()),
  dropped: await api.dropped(prune.movedTx.hash),
  txEffect: await api.txEffect(prune.movedTx.hash),
  contractInstance:
    contractAddress === undefined
      ? undefined
      : await api.contractInstance(contractAddress),
  dead: await Promise.all(prune.dead.map((b) => api.blockAt(b.hash))),
});

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** The API once it has consumed what the broker held when `want` was met or its time ran out; a consumer that never catches up fails the scenario. */
const settled = async (
  read: () => Promise<Snapshot>,
  want: Partial<Snapshot>,
  label: string,
) => {
  const { value, met, held } = await settle(read, {
    want,
    timeoutMs: SETTLE_TIMEOUT_MS,
    intervalMs: 1_000,
    cacheMs: CACHE_MS,
    consumedThrough: broker.apiConsumedThrough,
  });
  process.stdout.write(
    `${label}: ${met ? "expected state reached" : `expected state not reached in ${SETTLE_TIMEOUT_MS / 1000} s`}; once consumed, ${held ? "as expected" : "not as expected"}:\n${JSON.stringify(value, null, 2)}\n`,
  );
  return value;
};

/** Waits until the API serves each of `blocks` at its height, as canonical. */
const apiHolds = (blocks: BlockId[], label: string) =>
  vi.waitFor(
    async () =>
      expect(
        await Promise.all(blocks.map((b) => api.blockAt(b.height))),
        label,
      ).toEqual(blocks.map((b) => served(b, false))),
    { timeout: 60_000, interval: 1_000 },
  );

/** Whether a pass of the listener handles the current state by `deadline`. */
const handledBy = async (tip: number, deadline: number) => {
  for (;;) {
    if (prefixHandled((await control.status()).stateReads, tip)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(250);
  }
};

// Longer than today's 5 s tips poll, so a tips timer would show.
const SHORT_HOLD_MS = 7_000;
// Many passes of the listener's poll: a listener that never handles the
// shorter chain fails the check that needs it, not the whole scenario.
const SHORT_HOLD_LIMIT_MS = 15_000;

/** What must not move while the node serves the shorter chain. */
const quietView = async (prune: PruneFacts) => ({
  published: {
    block: await broker.published(endpoints.broker.blockTopic),
    tips: await broker.published(endpoints.broker.tipsTopic),
  },
  api: {
    latestHeight: await api.latestHeight(),
    dead: await Promise.all(prune.dead.map((b) => api.blockAt(b.height))),
    reorgs: byRoot(await api.reorgs()),
  },
});

type QuietView = Awaited<ReturnType<typeof quietView>>;

/**
 * Steps the node to the prune's last state; `beforePrune` runs before the
 * prune. Each state of the shorter chain is held until a pass of the listener
 * has handled it, or SHORT_HOLD_LIMIT_MS, and for at least SHORT_HOLD_MS, so
 * the scenario plays the order it names. Returns what must not move, read just
 * before the prune and at the end of the hold, and the states no pass handled,
 * when the prune has a shorter chain.
 */
const stepThrough = async (
  prune: PruneFacts,
  beforePrune: () => Promise<void>,
) => {
  let { current } = await control.status();
  let short:
    | { start: QuietView; end?: QuietView; unhandled: number[] }
    | undefined;
  const target = prune.dead[0].height - 1;
  while (current < prune.endAt) {
    await sleep(STEP_MS);
    if (current + 1 === prune.pruneAt) {
      await beforePrune();
      if (prune.shorterSteps > 0) {
        short = { start: await quietView(prune), unhandled: [] };
      }
    }
    ({ current } = await control.step());
    const steppedAt = Date.now();
    const lastShort = prune.pruneAt + prune.shorterSteps - 1;
    if (current >= prune.pruneAt && current <= lastShort) {
      if (!(await handledBy(target, steppedAt + SHORT_HOLD_LIMIT_MS))) {
        short?.unhandled.push(current);
      }
      await sleep(Math.max(0, SHORT_HOLD_MS - (Date.now() - steppedAt)));
      if (current === lastShort && short) {
        short.end = await quietView(prune);
      }
    }
  }
  return short;
};

const COMPARE_CHAIN = fileURLToPath(
  new URL("../scripts/compare-chain.ts", import.meta.url),
);

/** One check of the read-only checker against this run's node and API. */
const compareChain = (check: "sample" | "window") =>
  new Promise<{
    code: number;
    output: string;
    range?: HeightRange;
    firstMismatch: unknown;
  }>((resolve, reject) =>
    execFile(
      process.execPath,
      [COMPARE_CHAIN, check],
      {
        env: {
          ...process.env,
          COMPARE_NODE_URL: endpoints.aztecNodeUrl,
          COMPARE_API_URL: endpoints.explorerApiUrl,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : 0;
        if (error && code === 0) {
          reject(error);
          return;
        }
        let last: unknown;
        try {
          last = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        } catch {
          // Not a JSON line: the raw output stands in for the result.
        }
        const line = z
          .object({
            from: z.number(),
            to: z.number(),
            firstMismatch: z.unknown(),
          })
          .safeParse(last);
        resolve({
          code,
          output: stdout + stderr,
          range: line.success
            ? { from: line.data.from, to: line.data.to }
            : undefined,
          firstMismatch: line.success ? line.data.firstMismatch : stdout,
        });
      },
    ),
  );

/** The node's block at each height from `from`, and a 404 one past its tip. */
const expectedFrom = (prune: PruneFacts, from: number) => [
  ...prune.final.filter((b) => b.height >= from).map((b) => served(b, false)),
  { status: 404 },
];

const movedTxBlock = (prune: PruneFacts, height: number) =>
  served(prune.final[height - 1], false);

/** The one reorg a prune adds: rooted at its first dead block, counting all of them. */
const reorgOf = (prune: PruneFacts): ReorgRecord => ({
  height: prune.dead[0].height,
  nbrOfOrphanedBlocks: prune.dead.length,
  orphanedBlockHash: prune.dead[0].hash.toLowerCase(),
});

/** What the API must serve once a prune has settled, read from height `from`. */
const wantAfter = (
  prune: PruneFacts,
  from: number,
  reorgs: ReorgRecord[],
  withContract: boolean,
): Partial<Snapshot> => {
  const replacing = movedTxBlock(prune, prune.movedTx.finalHeight);
  return {
    latestHeight: prune.final.length,
    canonical: expectedFrom(prune, from),
    reorgs,
    dropped: { status: 404 },
    txEffect: replacing,
    ...(withContract
      ? { contractInstance: { hash: replacing.hash, orphaned: false } }
      : {}),
    dead: prune.dead.map((b) => served(b, true)),
  };
};

describe("a prune of blocks 7-10, replaced by 7'-12' on block 6", () => {
  let script: ScriptStatus;
  let prune: PruneFacts;
  let want: Partial<Snapshot>;
  let seen: Snapshot;
  let checkerBefore: Awaited<ReturnType<typeof compareChain>>;
  let checkerAfter: Record<
    "sample" | "window",
    Awaited<ReturnType<typeof compareChain>>
  >;
  let nodeTips: { finalized: number; proposed: number };

  beforeAll(async () => {
    script = await control.status();
    [prune] = script.prunes;
    await vi.waitFor(
      async () =>
        expect(
          (await control.status()).tipReads,
          "tip reads by the listener",
        ).toBeGreaterThan(1),
      { timeout: 60_000, interval: 500 },
    );
    const old = [
      ...prune.final.filter((b) => b.height < prune.dead[0].height),
      ...prune.dead,
    ];
    const deadHolder = prune.dead.find(
      (b) => b.height === prune.movedTx.deadHeight,
    );
    await stepThrough(prune, async () => {
      // The prune tests something only once the API holds what it removes,
      // the moved tx and its contract on their dead block included: on the
      // replacing block alone they would pass as a first insert.
      await apiHolds(old, "blocks 1-10 before the prune");
      await vi.waitFor(
        async () =>
          expect(
            {
              txEffect: await api.txEffect(prune.movedTx.hash),
              contractInstance: await api.contractInstance(
                script.contractAddress,
              ),
            },
            "the moved tx and its contract before the prune",
          ).toEqual({
            txEffect: deadHolder && served(deadHolder, false),
            contractInstance: {
              hash: deadHolder?.hash.toLowerCase(),
              orphaned: false,
            },
          }),
        { timeout: 30_000, interval: 1_000 },
      );
      checkerBefore = await compareChain("sample");
    });
    want = wantAfter(prune, 1, [reorgOf(prune)], true);
    seen = await settled(
      () => snapshot(prune, 1, script.contractAddress),
      want,
      "the API after the first prune",
    );
    checkerAfter = {
      sample: await compareChain("sample"),
      window: await compareChain("window"),
    };
    const tips = await createAztecNodeClient(
      endpoints.aztecNodeUrl,
    ).getChainTips();
    nodeTips = {
      finalized: Number(tips.finalized.block.number),
      proposed: Number(tips.proposed.number),
    };
  });

  it("has compare-chain name the API's first divergence from the node in each check's own range, and never print the endpoints", () => {
    const onApi = new Map(
      seen.canonical.flatMap((b) =>
        "hash" in b && !b.orphaned ? [[b.height, b.hash] as const] : [],
      ),
    );
    const onNode = new Map(
      prune.final.map((b) => [b.height, b.hash.toLowerCase()] as const),
    );
    const ranges = checkRanges({
      apiLatest: typeof seen.latestHeight === "number" ? seen.latestHeight : 0,
      nodeFinalized: nodeTips.finalized,
      nodeProposed: nodeTips.proposed,
    });
    expect
      .soft(checkerBefore, "before the prune")
      .toMatchObject({ code: 0, firstMismatch: null });
    for (const check of ["sample", "window"] as const) {
      const run = checkerAfter[check];
      const height = firstMismatch(ranges[check], onApi, onNode);
      expect.soft(run.range, `${check}: its range`).toEqual(ranges[check]);
      expect
        .soft(run.code, `${check}: exit code`)
        .toBe(height === undefined ? 0 : 1);
      expect
        .soft(run.firstMismatch, `${check}: first mismatch`)
        .toEqual(
          height === undefined ? null : expect.objectContaining({ height }),
        );
    }
    for (const run of [checkerBefore, ...Object.values(checkerAfter)]) {
      for (const url of [endpoints.aztecNodeUrl, endpoints.explorerApiUrl]) {
        expect.soft(run.output).not.toContain(new URL(url).host);
      }
    }
  });

  it("serves the script's final chain as canonical, and nothing above it", () => {
    expect.soft(seen.latestHeight, "latest height").toBe(want.latestHeight);
    expect
      .soft(seen.canonical, "the canonical block at each height")
      .toEqual(want.canonical);
  });

  it("lists one reorg: the 4 blocks from height 7", () => {
    expect(seen.reorgs).toEqual(want.reorgs);
  });

  it("keeps the moved tx mined, not dropped, and the contract on the replacing block", () => {
    expect.soft(seen.dropped, "dropped-tx lookup").toEqual(want.dropped);
    expect.soft(seen.txEffect, "tx effect").toEqual(want.txEffect);
    expect
      .soft(seen.contractInstance, "contract instance")
      .toEqual(want.contractInstance);
  });

  it("serves each dead block by its hash, as orphaned", () => {
    expect(seen.dead).toEqual(want.dead);
  });
});

describe("a prune of blocks 13'-16' that serves the shorter chain, tip 12', before 13''-16'", () => {
  let prune: PruneFacts;
  let baseline: ReorgRecord[];
  let short: Awaited<ReturnType<typeof stepThrough>>;
  let want: Partial<Snapshot>;
  let seen: Snapshot;

  beforeAll(async () => {
    prune = (await control.status()).prunes[1];
    const deadHolder = prune.dead.find(
      (b) => b.height === prune.movedTx.deadHeight,
    );
    short = await stepThrough(prune, async () => {
      await apiHolds(prune.dead, "blocks 13'-16' before the prune");
      await vi.waitFor(
        async () =>
          expect(
            await api.txEffect(prune.movedTx.hash),
            "the moved tx before the prune",
          ).toEqual(deadHolder && served(deadHolder, false)),
        { timeout: 30_000, interval: 1_000 },
      );
      baseline = await api.reorgList();
    });
    want = wantAfter(
      prune,
      prune.dead[0].height,
      plusReorg(baseline, reorgOf(prune)),
      false,
    );
    process.stdout.write(
      `while the node served the shorter chain:\n${JSON.stringify(short, null, 2)}\n`,
    );
    seen = await settled(
      () => snapshot(prune, prune.dead[0].height),
      want,
      "the API after the second prune",
    );
  });

  it("publishes no block and no tips record, and keeps its state, while the node serves the shorter chain", () => {
    expect
      .soft(short?.unhandled, "states of the shorter chain no pass handled")
      .toEqual([]);
    expect
      .soft(short?.end?.published, "records published")
      .toEqual(short?.start.published);
    expect.soft(short?.end?.api, "the API's state").toEqual(short?.start.api);
  });

  it("serves the node's chain above 12' as canonical, and nothing above it", () => {
    expect.soft(seen.latestHeight, "latest height").toBe(want.latestHeight);
    expect
      .soft(seen.canonical, "the canonical block at each height")
      .toEqual(want.canonical);
  });

  it("adds one reorg to those before it: the 4 blocks from height 13", () => {
    expect(seen.reorgs).toEqual(want.reorgs);
  });

  it("keeps the moved tx mined, not dropped, on the replacing block", () => {
    expect.soft(seen.dropped, "dropped-tx lookup").toEqual(want.dropped);
    expect.soft(seen.txEffect, "tx effect").toEqual(want.txEffect);
  });

  it("serves each dead block by its hash, as orphaned", () => {
    expect(seen.dead).toEqual(want.dead);
  });
});

describe("the block topic, after both prunes", () => {
  // Spaced steps reach the API in order from any partition, so the scenarios
  // cannot show where the block records went; the broker can.
  it("holds every block record in one of its partitions", async () => {
    const partitions = await broker.recordsPerPartition(
      endpoints.broker.blockTopic,
    );
    expect(partitions.length, "partitions").toBeGreaterThan(1);
    expect(
      partitions.filter((p) => p.records > 0),
      "partitions holding records",
    ).toHaveLength(1);
  });
});
