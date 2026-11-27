import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RpcTap,
  type TipRead,
  pruneOrder,
  readTipReads,
  startRpcTap,
} from "./rpc-tap.js";

const HASH = `0x${"ab".repeat(32)}`;
const tip = (number: number) => ({
  block: { number, hash: HASH },
  checkpoint: { number, hash: HASH },
});

type Call = { id: number; method: string; params: unknown[] };

const answer = ({ id, method, params }: Call) => {
  switch (method) {
    case "aztec_getBlockNumber":
      return { jsonrpc: "2.0", id, result: params[0] === "proven" ? 5 : 7 };
    case "aztec_getChainTips":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          proposed: { number: 7, hash: HASH },
          checkpointed: tip(7),
          proven: tip(5),
          finalized: tip(5),
        },
      };
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      };
  }
};

// Compressed, as the SDK's server compresses large answers.
const fakeNode = () =>
  createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const calls = JSON.parse(body) as Call[];
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(JSON.stringify(calls.map(answer))));
    });
  });

describe("rpc tap", () => {
  let dir: string;
  let upstream: Server;
  let tap: RpcTap;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chicmoz-rpc-tap-"));
    upstream = fakeNode();
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const { port } = upstream.address() as AddressInfo;
    tap = await startRpcTap({
      port: 0,
      upstream: `http://127.0.0.1:${port}`,
      file: join(dir, "tap.jsonl"),
    });
  });

  afterAll(async () => {
    await tap?.close();
    upstream?.closeAllConnections();
    upstream?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes the SDK client's batch through and records only its proposed-tip reads", async () => {
    const client = createAztecNodeClient(tap.url);
    const answers = await Promise.all([
      client.getBlockNumber(),
      client.getBlockNumber("proven"),
      client.getChainTips().then((t) => Number(t.proposed.number)),
      client.getNodeVersion().catch((e: Error) => e.message),
    ]);
    expect(answers).toEqual([7, 5, 7, "Method not found"]);
    expect(
      readTipReads(join(dir, "tap.jsonl")).map((r) => ({
        method: r.method,
        proposed: r.proposed,
        hash: r.hash,
      })),
    ).toEqual([
      { method: "getBlockNumber", proposed: 7 },
      { method: "getChainTips", proposed: 7, hash: HASH },
    ]);
  });

  describe("the state of a prune that the client read first", () => {
    const read = (at: number, proposed: number, hash?: string): TipRead => ({
      at,
      method: hash === undefined ? "getBlockNumber" : "getChainTips",
      proposed,
      ...(hash === undefined ? {} : { hash }),
    });
    // Target 6, doomed 7 and 8; the tip also sat at 6 before they were built.
    const window = {
      since: 100,
      target: 6,
      before: new Map([
        [6, "0x06"],
        [7, "0x07"],
        [8, "0x08"],
      ]),
    };
    const early = [read(50, 6), read(90, 8)];

    it("goes by the earliest answer that shows the shorter chain or the replacement", () => {
      expect(
        pruneOrder([...early, read(200, 6), read(400, 7)], window).order,
      ).toBe("shorter-chain-first");
      expect(pruneOrder([...early, read(400, 7)], window).order).toBe(
        "replacement-first",
      );
      expect(pruneOrder(early, window).order).toBe("unseen");
    });

    it("keeps a replacement read first when a target reply arrives after it", () => {
      // The target reply's request went out first, so it is recorded first.
      const reads = [...early, read(450, 6), read(300, 7)];
      const order = pruneOrder(reads, window);
      expect(order.order).toBe("replacement-first");
      expect(order.decisiveRead).toMatchObject({
        proposed: 7,
        afterWarpMs: 200,
      });
    });

    it("reads the old tip as neither state, unless a hash shows another block", () => {
      expect(
        pruneOrder([read(200, 8), read(250, 8, "0x08")], window).order,
      ).toBe("unseen");
      expect(
        pruneOrder([read(200, 8), read(250, 8, "0x8f"), read(300, 6)], window)
          .order,
      ).toBe("replacement-first");
    });
  });
});
