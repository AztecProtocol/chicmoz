import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readScriptedEndpoints } from "./endpoints.js";
import {
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

// Two of the listener's 1 s polls per state.
const STEP_MS = 2_000;
// Longer than the API's 5 s block cache.
const SETTLE_GAP_MS = 6_000;
const SETTLE_TIMEOUT_MS = 90_000;

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
  reorgs: await api.reorgs(),
  dropped: await api.dropped(prune.movedTx.hash),
  txEffect: await api.txEffect(prune.movedTx.hash),
  contractInstance:
    contractAddress === undefined
      ? undefined
      : await api.contractInstance(contractAddress),
  dead: await Promise.all(prune.dead.map((b) => api.blockAt(b.hash))),
});

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

const settled = async (read: () => Promise<Snapshot>, label: string) => {
  const { value, settled: done } = await settle(read, {
    gapMs: SETTLE_GAP_MS,
    timeoutMs: SETTLE_TIMEOUT_MS,
    progress: async () => (await control.status()).tipReads,
  });
  process.stdout.write(
    `${label}, ${done ? "settled" : `still changing after ${SETTLE_TIMEOUT_MS / 1000} s`}:\n${JSON.stringify(value, null, 2)}\n`,
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

describe("a prune of blocks 7-10, replaced by 7'-12' on block 6", () => {
  let script: ScriptStatus;
  let prune: PruneFacts;
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
    await stepThrough(prune, async () => {
      // The prune tests something only once the API holds what it removes.
      await apiHolds(old, "blocks 1-10 before the prune");
      checkerBefore = await compareChain("sample");
    });
    seen = await settled(
      () => snapshot(prune, 1, script.contractAddress),
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
    expect.soft(seen.latestHeight, "latest height").toBe(prune.final.length);
    expect
      .soft(seen.canonical, "the canonical block at each height")
      .toEqual(expectedFrom(prune, 1));
  });

  it("lists one reorg: the 4 blocks from height 7", () => {
    expect(seen.reorgs).toEqual([
      {
        height: prune.dead[0].height,
        nbrOfOrphanedBlocks: prune.dead.length,
        orphanedBlockHash: prune.dead[0].hash.toLowerCase(),
      },
    ]);
  });

  it("keeps the moved tx mined, not dropped, and the contract on the replacing block", () => {
    const replacing = movedTxBlock(prune, prune.movedTx.finalHeight);
    expect.soft(seen.dropped, "dropped-tx lookup").toEqual({ status: 404 });
    expect.soft(seen.txEffect, "tx effect").toEqual(replacing);
    expect
      .soft(seen.contractInstance, "contract instance")
      .toEqual({ hash: replacing.hash, orphaned: false });
  });

  it("serves each dead block by its hash, as orphaned", () => {
    expect(seen.dead).toEqual(prune.dead.map((b) => served(b, true)));
  });
});

describe("a prune of blocks 13'-16' that serves the shorter chain, tip 12', before 13''-16'", () => {
  let prune: PruneFacts;
  let baseline: Snapshot["reorgs"];
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
      baseline = await api.reorgs();
    });
    seen = await settled(
      () => snapshot(prune, prune.dead[0].height),
      "the API after the second prune",
    );
  });

  it("serves the node's chain above 12' as canonical, and nothing above it", () => {
    expect.soft(seen.latestHeight, "latest height").toBe(prune.final.length);
    expect
      .soft(seen.canonical, "the canonical block at each height")
      .toEqual(expectedFrom(prune, prune.dead[0].height));
  });

  it("adds one reorg to those before it: the 4 blocks from height 13", () => {
    expect(byRoot(seen.reorgs)).toEqual(
      plusReorg(baseline, {
        height: prune.dead[0].height,
        nbrOfOrphanedBlocks: prune.dead.length,
        orphanedBlockHash: prune.dead[0].hash.toLowerCase(),
      }),
    );
  });

  it("keeps the moved tx mined, not dropped, on the replacing block", () => {
    expect.soft(seen.dropped, "dropped-tx lookup").toEqual({ status: 404 });
    expect
      .soft(seen.txEffect, "tx effect")
      .toEqual(movedTxBlock(prune, prune.movedTx.finalHeight));
  });

  it("serves each dead block by its hash, as orphaned", () => {
    expect(seen.dead).toEqual(prune.dead.map((b) => served(b, true)));
  });
});
