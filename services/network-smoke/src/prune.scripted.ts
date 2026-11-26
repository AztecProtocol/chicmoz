import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readScriptedEndpoints } from "./endpoints.js";
import { explorerReads, served, settle } from "./explorer-reads.js";
import { type ScriptStatus, scriptControl } from "./script-control.js";

const endpoints = readScriptedEndpoints();
const control = scriptControl(endpoints.controlUrl);
const api = explorerReads(endpoints.explorerApiUrl);

// Two of the listener's 1 s polls per state.
const STEP_MS = 2_000;
// Longer than the API's 5 s block cache.
const SETTLE_GAP_MS = 6_000;
const SETTLE_TIMEOUT_MS = 90_000;

const snapshot = async ({
  final,
  dead,
  movedTx,
  contractAddress,
}: ScriptStatus) => ({
  latestHeight: await api.latestHeight(),
  // One height past the final chain, which must not exist.
  canonical: await Promise.all(
    [...final.map((b) => b.height), final.length + 1].map(api.blockAt),
  ),
  reorgs: await api.reorgs(),
  dropped: await api.dropped(movedTx.hash),
  txEffect: await api.txEffect(movedTx.hash),
  contractInstance: await api.contractInstance(contractAddress),
  dead: await Promise.all(dead.map((b) => api.blockAt(b.hash))),
});

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

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

describe("a prune of blocks 7-10, replaced by 7'-12' on block 6", () => {
  let script: ScriptStatus;
  let seen: Snapshot;
  let checkerBefore: Awaited<ReturnType<typeof compareChain>>;
  let checkerAfter: Awaited<ReturnType<typeof compareChain>>[];

  beforeAll(async () => {
    script = await control.status();
    await vi.waitFor(
      async () =>
        expect(
          (await control.status()).tipReads,
          "tip reads by the listener",
        ).toBeGreaterThan(1),
      { timeout: 60_000, interval: 500 },
    );
    const old = [
      ...script.final.filter((b) => b.height < script.dead[0].height),
      ...script.dead,
    ];
    for (let next = 1; next < script.states.length; next++) {
      await sleep(STEP_MS);
      if (next === script.pruneAt) {
        // The prune tests something only once the API holds what it removes.
        await vi.waitFor(
          async () =>
            expect(
              await Promise.all(old.map((b) => api.blockAt(b.height))),
              "blocks 1-10 before the prune",
            ).toEqual(old.map((b) => served(b, false))),
          { timeout: 60_000, interval: 1_000 },
        );
        checkerBefore = await compareChain("sample");
      }
      await control.step();
    }

    // Settled while the listener kept polling the last state.
    const { value, settled } = await settle(() => snapshot(script), {
      gapMs: SETTLE_GAP_MS,
      timeoutMs: SETTLE_TIMEOUT_MS,
      progress: async () => (await control.status()).tipReads,
    });
    seen = value;
    process.stdout.write(
      `the API after the script, ${settled ? "settled" : `still changing after ${SETTLE_TIMEOUT_MS / 1000} s`}:\n${JSON.stringify(value, null, 2)}\n`,
    );
    checkerAfter = [await compareChain("sample"), await compareChain("window")];
  });

  it("has compare-chain name the API's first divergence from the node, and never print the endpoints", () => {
    const expected = [
      ...script.final.map((b) => served(b, false)),
      { status: 404 },
    ];
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
    expect.soft(seen.latestHeight, "latest height").toBe(script.final.length);
    expect
      .soft(seen.canonical, "the canonical block at each height")
      .toEqual([...script.final.map((b) => served(b, false)), { status: 404 }]);
  });

  it("lists one reorg: the 4 blocks from height 7", () => {
    expect(seen.reorgs).toEqual([
      {
        height: script.dead[0].height,
        nbrOfOrphanedBlocks: script.dead.length,
        orphanedBlockHash: script.dead[0].hash.toLowerCase(),
      },
    ]);
  });

  it("keeps the moved tx mined, not dropped, and the contract on the replacing block", () => {
    const replacing = served(
      script.final[script.movedTx.finalHeight - 1],
      false,
    );
    expect.soft(seen.dropped, "dropped-tx lookup").toEqual({ status: 404 });
    expect.soft(seen.txEffect, "tx effect").toEqual(replacing);
    expect
      .soft(seen.contractInstance, "contract instance")
      .toEqual({ hash: replacing.hash, orphaned: false });
  });

  it("serves each dead block by its hash, as orphaned", () => {
    expect(seen.dead).toEqual(script.dead.map((b) => served(b, true)));
  });
});
