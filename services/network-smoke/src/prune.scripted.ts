import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { brokerReads } from "./broker.js";
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

/**
 * Steps the node to the prune's last state. `beforePrune` runs before the
 * prune, and a state of the shorter chain is held until the listener has read
 * its tip, so the scenario always plays the order it names.
 */
const stepThrough = async (
  prune: PruneFacts,
  beforePrune: () => Promise<void>,
) => {
  let { current } = await control.status();
  while (current < prune.endAt) {
    await sleep(STEP_MS);
    if (current + 1 === prune.pruneAt) {
      await beforePrune();
    }
    ({ current } = await control.step());
    if (
      current >= prune.pruneAt &&
      current < prune.pruneAt + prune.shorterSteps
    ) {
      await vi.waitFor(
        async () =>
          expect(
            (await control.status()).stateReads,
            `the listener's reads of the shorter chain, state ${current}`,
          ).toBeGreaterThan(0),
        { timeout: 30_000, interval: 250 },
      );
    }
  }
};

const COMPARE_CHAIN = fileURLToPath(
  new URL("../scripts/compare-chain.ts", import.meta.url),
);

/** One check of the read-only checker against this run's node and API. */
const compareChain = (check: "sample" | "window") =>
  new Promise<{ code: number; output: string; firstMismatch: unknown }>(
    (resolve, reject) =>
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
          const line = z.object({ firstMismatch: z.unknown() }).safeParse(last);
          resolve({
            code,
            output: stdout + stderr,
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
  let checkerAfter: Awaited<ReturnType<typeof compareChain>>[];

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
    checkerAfter = [await compareChain("sample"), await compareChain("window")];
  });

  it("has compare-chain name the API's first divergence from the node, and never print the endpoints", () => {
    const expected = expectedFrom(prune, 1);
    const diverged = seen.canonical.findIndex(
      (b, i) => JSON.stringify(b) !== JSON.stringify(expected[i]),
    );
    const firstHeight = diverged < 0 ? undefined : diverged + 1;
    expect
      .soft(checkerBefore, "before the prune")
      .toMatchObject({ code: 0, firstMismatch: null });
    for (const [i, run] of checkerAfter.entries()) {
      const check = ["sample", "window"][i];
      expect
        .soft(run.code, `${check}: exit code`)
        .toBe(firstHeight === undefined ? 0 : 1);
      expect
        .soft(run.firstMismatch, `${check}: first mismatch`)
        .toEqual(
          firstHeight === undefined
            ? null
            : expect.objectContaining({ height: firstHeight }),
        );
    }
    for (const run of [checkerBefore, ...checkerAfter]) {
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
  let want: Partial<Snapshot>;
  let seen: Snapshot;

  beforeAll(async () => {
    prune = (await control.status()).prunes[1];
    const deadHolder = prune.dead.find(
      (b) => b.height === prune.movedTx.deadHeight,
    );
    await stepThrough(prune, async () => {
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
    seen = await settled(
      () => snapshot(prune, prune.dead[0].height),
      want,
      "the API after the second prune",
    );
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
  // Spaced steps reach the API in order from any partition; only a single
  // partition holds the records in the order they were sent.
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
