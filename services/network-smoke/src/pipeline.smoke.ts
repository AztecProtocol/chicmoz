import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import {
  chicmozL2BlockLightSchema,
  chicmozL2TipsHealthSchema,
  chicmozL2TxEffectDeluxeSchema,
} from "@chicmoz-pkg/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readEndpoints } from "./endpoints.js";
import { expectedBlocks } from "./oracle.js";
import { type SentTx, sendTx } from "./send-tx.js";
import { type WsClient, connectWs } from "./ws-client.js";

const endpoints = readEndpoints();
const node = createAztecNodeClient(endpoints.aztecNodeUrl);

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(new URL(path, endpoints.explorerApiUrl), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
};
const latestHeight = async () =>
  z
    .number()
    .int()
    .parse(await get("/l2/latest-height"));

// The message bus logs this line each time a handler throws and the message
// will be redelivered (packages/message-bus/src/class.ts).
const HANDLER_FAILURE = /Provided callback for topic (\S+) failed/;

describe("explorer pipeline on a local Aztec network", () => {
  let ws: WsClient;
  let sent: SentTx;

  beforeAll(async () => {
    ws = await connectWs(endpoints.wsUrl);
  });

  afterAll(() => {
    ws?.close();
  });

  it("delivers an L2 block to the API", async () => {
    await vi.waitFor(
      async () => {
        expect(await latestHeight(), "latest height").toBeGreaterThanOrEqual(1);
        const block = chicmozL2BlockLightSchema.parse(
          await get("/l2/blocks/1"),
        );
        expect(Number(block.height)).toBe(1);
      },
      { timeout: 120_000, interval: 1_000 },
    );
  });

  it("serves the test's own transaction at its block", async () => {
    sent = await sendTx(node);
    expect(sent.blockNumber, "receipt block").toBeGreaterThan(0);
    await vi.waitFor(
      async () => {
        const effect = chicmozL2TxEffectDeluxeSchema.parse(
          await get(`/l2/tx-effects/${sent.txHash}`),
        );
        expect(effect.txHash.toLowerCase()).toBe(sent.txHash);
        expect(Number(effect.blockHeight)).toBe(sent.blockNumber);
      },
      { timeout: 90_000, interval: 1_000 },
    );
  });

  it("streams the transaction's block over the websocket with the node's hash", async () => {
    const block = await node.getBlock(BlockNumber(sent.blockNumber));
    expect(block, `node block ${sent.blockNumber}`).toBeDefined();
    const nodeHash = block?.hash.toString().toLowerCase();
    await vi.waitFor(
      () => {
        expect(ws.rejected, "block frames failing the shared schema").toEqual(
          [],
        );
        const frame = ws.blocks.find(
          (b) => Number(b.height) === sent.blockNumber,
        );
        expect(
          frame?.hash.toLowerCase(),
          `block ${sent.blockNumber} among ws heights [${ws.blocks.map((b) => b.height).join(",")}]`,
        ).toBe(nodeHash);
      },
      { timeout: 60_000, interval: 500 },
    );
  });

  it("serves every block up to the transaction's with the node's hash and its L1 proposal", async () => {
    const expected = await expectedBlocks(
      node,
      endpoints.anvilUrl,
      sent.blockNumber,
    );
    const missing = expected.filter((e) => e.proposal === undefined);
    expect(
      missing.map((e) => e.height),
      "heights without a rollup log",
    ).toEqual([]);
    await vi.waitFor(
      async () => {
        expect(await latestHeight(), "latest height").toBeGreaterThanOrEqual(
          sent.blockNumber,
        );
        const mismatches: string[] = [];
        for (const e of expected) {
          const block = chicmozL2BlockLightSchema.parse(
            await get(`/l2/blocks/${e.height}`),
          );
          const proposed = block.proposedOnL1;
          const actual = {
            height: Number(block.height),
            hash: block.hash.toLowerCase(),
            archive: proposed?.archive.toLowerCase(),
            l1BlockNumber: proposed?.l1BlockNumber,
            l1TransactionHash: proposed?.l1TransactionHash?.toLowerCase(),
          };
          const want = {
            height: e.height,
            hash: e.hash,
            archive: e.archive,
            l1BlockNumber: e.proposal?.l1BlockNumber,
            l1TransactionHash: e.proposal?.l1TransactionHash.toLowerCase(),
          };
          if (
            JSON.stringify(actual, bigints) !== JSON.stringify(want, bigints)
          ) {
            mismatches.push(
              `${e.height}: api ${JSON.stringify(actual, bigints)} != node/L1 ${JSON.stringify(want, bigints)}`,
            );
          }
        }
        expect(mismatches).toEqual([]);
      },
      { timeout: 120_000, interval: 3_000 },
    );
  });

  it("reports tips that are fresh and not degraded", async () => {
    await vi.waitFor(
      async () => {
        const health = chicmozL2TipsHealthSchema.parse(await get("/l2/tips"));
        expect(health.degraded, health.degradedReason ?? "").toBe(false);
        expect(health.stale, `tips ${health.stalenessMs} ms old`).toBe(false);
        expect(health.tips.proposed.number).toBeGreaterThanOrEqual(
          sent.blockNumber,
        );
      },
      { timeout: 60_000, interval: 2_000 },
    );
  });

  it("has no handler failing over and over on real traffic", () => {
    const counts = new Map<string, number>();
    for (const service of endpoints.consumerLogs) {
      const log = readFileSync(
        join(endpoints.logDir, `${service}.log`),
        "utf8",
      );
      for (const line of log.split("\n")) {
        const topic = HANDLER_FAILURE.exec(line)?.[1];
        if (topic) {
          const key = `${service} ${topic}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    if (counts.size > 0) {
      process.stdout.write(
        `handler failures: ${JSON.stringify(Object.fromEntries(counts))}\n`,
      );
    }
    // One or two failures that succeed on redelivery are at-least-once
    // delivery working; a message no handler accepts fails on every
    // redelivery.
    const repeated = Object.fromEntries([...counts].filter(([, n]) => n >= 3));
    expect(repeated, "handler failures per service and topic").toEqual({});
  });
});

function bigints(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}
