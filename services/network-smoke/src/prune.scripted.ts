import { setTimeout as sleep } from "node:timers/promises";
import {
  chicmozL2BlockLightSchema,
  chicmozL2ContractInstanceDeluxeSchema,
  chicmozL2DroppedTxSchema,
  chicmozL2TxEffectDeluxeSchema,
  chicmozReorgSchema,
} from "@chicmoz-pkg/types";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readScriptedEndpoints } from "./endpoints.js";
import {
  type BlockId,
  type ScriptStatus,
  scriptControl,
} from "./script-control.js";

const endpoints = readScriptedEndpoints();
const control = scriptControl(endpoints.controlUrl);

// Two of the listener's 1 s polls per state.
const STEP_MS = 2_000;
// Longer than the API's 5 s block cache, so two equal reads this far apart
// show the API's state, not one cache entry read twice.
const SETTLE_GAP_MS = 6_000;
const SETTLE_TIMEOUT_MS = 90_000;

const get = async (path: string) => {
  const res = await fetch(new URL(path, endpoints.explorerApiUrl), {
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the text itself is the answer.
  }
  return { status: res.status, body };
};

/** What the API serves for `path`, through `pick`; any other status as itself. */
const read = async <T>(path: string, pick: (body: unknown) => T) => {
  const { status, body } = await get(path);
  return status === 200 ? pick(body) : { status };
};

const blockAt = (heightOrHash: number | string) =>
  read(`/l2/blocks/${heightOrHash}`, (body) => {
    const block = chicmozL2BlockLightSchema.parse(body);
    return {
      height: Number(block.height),
      hash: block.hash.toLowerCase(),
      orphaned: block.orphan !== undefined,
    };
  });

const served = ({ height, hash }: BlockId, orphaned: boolean) => ({
  height,
  hash: hash.toLowerCase(),
  orphaned,
});

const snapshot = async ({
  final,
  dead,
  movedTx,
  contractAddress,
}: ScriptStatus) => ({
  latestHeight: await read("/l2/latest-height", (body) =>
    z.number().int().parse(body),
  ),
  // One height past the final chain, which must not exist.
  canonical: await Promise.all(
    [...final.map((b) => b.height), final.length + 1].map(blockAt),
  ),
  reorgs: await read("/l2/reorgs", (body) =>
    z
      .array(chicmozReorgSchema)
      .parse(body)
      .map((r) => ({
        height: Number(r.height),
        nbrOfOrphanedBlocks: r.nbrOfOrphanedBlocks,
        orphanedBlockHash: r.orphanedBlockHash.toLowerCase(),
      })),
  ),
  dropped: await read(`/l2/dropped-txs/${movedTx.hash}`, (body) => {
    const { dropReason } = chicmozL2DroppedTxSchema.parse(body);
    return { status: 200, dropReason };
  }),
  txEffect: await read(`/l2/tx-effects/${movedTx.hash}`, (body) => {
    const effect = chicmozL2TxEffectDeluxeSchema.parse(body);
    return {
      height: Number(effect.blockHeight),
      hash: effect.blockHash.toLowerCase(),
      orphaned: effect.isOrphaned,
    };
  }),
  contractInstance: await read(
    `/l2/contract-instances/${contractAddress}`,
    (body) => {
      const instance = chicmozL2ContractInstanceDeluxeSchema.parse(body);
      return {
        hash: instance.blockHash.toLowerCase(),
        orphaned: instance.isOrphaned,
      };
    },
  ),
  dead: await Promise.all(dead.map((b) => blockAt(b.hash))),
});

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

describe("a prune of blocks 7-10, replaced by 7'-12' on block 6", () => {
  let script: ScriptStatus;
  let api: Snapshot;

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
              await Promise.all(old.map((b) => blockAt(b.height))),
              "blocks 1-10 before the prune",
            ).toEqual(old.map((b) => served(b, false))),
          { timeout: 60_000, interval: 1_000 },
        );
      }
      await control.step();
    }

    // Settled: two equal reads a cache lifetime apart while the listener
    // kept polling the last state.
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let reads = (await control.status()).tipReads;
    api = await snapshot(script);
    let settled = false;
    while (!settled && Date.now() < deadline) {
      await sleep(SETTLE_GAP_MS);
      const next = await snapshot(script);
      const nextReads = (await control.status()).tipReads;
      settled =
        JSON.stringify(next) === JSON.stringify(api) && nextReads > reads;
      api = next;
      reads = nextReads;
    }
    process.stdout.write(
      `the API after the script, ${settled ? "settled" : `still changing after ${SETTLE_TIMEOUT_MS / 1000} s`}:\n${JSON.stringify(api, null, 2)}\n`,
    );
  });

  it("serves the script's final chain as canonical, and nothing above it", () => {
    expect.soft(api.latestHeight, "latest height").toBe(script.final.length);
    expect
      .soft(api.canonical, "the canonical block at each height")
      .toEqual([...script.final.map((b) => served(b, false)), { status: 404 }]);
  });

  it("lists one reorg: the 4 blocks from height 7", () => {
    expect(api.reorgs).toEqual([
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
    expect.soft(api.dropped, "dropped-tx lookup").toEqual({ status: 404 });
    expect.soft(api.txEffect, "tx effect").toEqual(replacing);
    expect
      .soft(api.contractInstance, "contract instance")
      .toEqual({ hash: replacing.hash, orphaned: false });
  });

  it("serves each dead block by its hash, as orphaned", () => {
    expect(api.dead).toEqual(script.dead.map((b) => served(b, true)));
  });
});
