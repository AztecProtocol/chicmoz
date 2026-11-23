import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import {
  type Hex,
  encodeEventTopics,
  getContract,
  pad,
  parseAbi,
  toHex,
} from "viem";
import { foundry } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createWebSocketClient } from "../src/network-client/client/web-socket-client.js";

const lines = vi.hoisted(() => [] as string[]);
vi.mock("../src/logger.js", () => {
  const log = (line: string) => {
    lines.push(line);
  };
  return { logger: { debug: log, info: log, warn: log, error: log } };
});

beforeEach(() => {
  lines.length = 0;
});

const DELAY_MS = 50;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const abi = parseAbi(["event Foo(uint256 indexed x)"]);
const address = "0x00000000000000000000000000000000000000aa";
const logAt = (block: bigint) => ({
  address,
  topics: encodeEventTopics({ abi, eventName: "Foo", args: { x: block } }),
  data: "0x",
  blockNumber: toHex(block),
  blockHash: pad(toHex(block), { size: 32 }),
  transactionHash: pad(toHex(block), { size: 32 }),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
});

type Chain = { head: bigint; logs: Map<bigint, ReturnType<typeof logAt>[]> };
/** Filter id to the first block its next getFilterChanges returns. */
type Filters = Map<string, bigint>;
let filterIds = 0;

/**
 * JSON-RPC over WebSocket. A new filter's first getFilterChanges returns the
 * logs since its fromBlock, as anvil does, so a filter re-created from an old
 * block re-delivers.
 */
const startNode = async ({
  port = 0,
  chain = { head: 100n, logs: new Map() },
  filters = new Map(),
  handshakeDelayMs = 0,
  uninstallDelayMs = 0,
}: {
  port?: number;
  chain?: Chain;
  filters?: Filters;
  handshakeDelayMs?: number;
  /** Answers eth_uninstallFilter after later requests, as a node serving calls concurrently may. */
  uninstallDelayMs?: number;
} = {}) => {
  const newFilters: bigint[] = [];
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port,
    verifyClient: (_info, accept) =>
      setTimeout(() => accept(true), handshakeDelayMs),
  });
  await once(wss, "listening");
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const { id, method, params } = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params?: [unknown];
      };
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      const unknownFilter = () =>
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "filter not found" },
          }),
        );
      const filterId = String(params?.[0]);
      switch (method) {
        case "eth_blockNumber":
          return reply(toHex(chain.head));
        case "eth_newFilter": {
          const { fromBlock } = params?.[0] as { fromBlock: Hex };
          const created = toHex(++filterIds);
          newFilters.push(BigInt(fromBlock));
          filters.set(created, BigInt(fromBlock));
          return reply(created);
        }
        case "eth_getFilterChanges": {
          const from = filters.get(filterId);
          if (from === undefined) {
            return unknownFilter();
          }
          filters.set(filterId, chain.head + 1n);
          return reply(
            [...chain.logs]
              .filter(([block]) => block >= from && block <= chain.head)
              .flatMap(([, logs]) => logs),
          );
        }
        case "eth_uninstallFilter":
          return setTimeout(
            () => (filters.delete(filterId) ? reply(true) : unknownFilter()),
            uninstallDelayMs,
          );
        default:
          return reply(null);
      }
    });
  });
  return {
    port: (wss.address() as AddressInfo).port,
    filters,
    newFilters,
    openSockets: () =>
      [...wss.clients].filter((c) => c.readyState === c.OPEN).length,
    close: async () => {
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      await once(wss, "close");
    },
  };
};

/** Accepts and drops every connection, counting the attempts. */
const startDeadPort = async (port: number) => {
  let attempts = 0;
  const server = createServer((socket) => {
    attempts++;
    socket.destroy();
  }).listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    attempts: () => attempts,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

describe("L1 WebSocket client", () => {
  it("rides out an outage past viem's reconnect budget: one attempt per delay, one socket after", async () => {
    let node = await startNode();
    const { port } = node;
    const { client, close } = createWebSocketClient({
      chain: foundry,
      url: `ws://127.0.0.1:${port}`,
      reconnectDelayMs: DELAY_MS,
      reportIntervalMs: 200,
    });
    const blockNumber = () =>
      client.request({ method: "eth_blockNumber" }, { retryCount: 0 });
    await expect(blockNumber()).resolves.toBe("0x64");

    await node.close();
    const deadPort = await startDeadPort(port);
    const outageStart = Date.now();
    let failed = 0;
    await blockNumber().catch(() => failed++);
    expect(lines).toEqual([
      expect.stringMatching(/^L1 WebSocket unavailable /),
    ]);

    // Eight callers every 5 ms: far more requests than connection attempts.
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (Date.now() - outageStart < 1_000) {
          await blockNumber().catch(() => failed++);
          await sleep(5);
        }
      }),
    );
    await deadPort.close();
    const outageMs = Date.now() - outageStart;
    expect(deadPort.attempts()).toBeGreaterThanOrEqual(outageMs / DELAY_MS / 2);
    expect(deadPort.attempts()).toBeLessThanOrEqual(outageMs / DELAY_MS + 1);

    node = await startNode({ port, handshakeDelayMs: 30 });
    await sleep(DELAY_MS);
    // Callers arriving during the handshake share its one socket.
    const results = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        await sleep(i * 3);
        return blockNumber();
      }),
    );
    expect(results).toEqual(Array(8).fill("0x64"));
    expect(node.openSockets()).toBe(1);

    // First failure at once, periodic counts, one recovery line; none dropped.
    const [, ...reports] = lines;
    expect(reports.length).toBeGreaterThanOrEqual(3);
    expect(reports.at(-1)).toMatch(/^L1 WebSocket reconnected after /);
    const counted = reports.map((line) =>
      Number(/failed requests since the last report: (\d+)$/.exec(line)?.[1]),
    );
    expect(1 + counted.reduce((sum, n) => sum + n, 0)).toBe(failed);

    close();
    await node.close();
  });

  it("restarts a watcher after its last delivered block, whether the node lost or kept its filters", async () => {
    const chain: Chain = { head: 11n, logs: new Map([[11n, [logAt(11n)]]]) };
    let node = await startNode({ chain });
    const { port } = node;
    const { client, close } = createWebSocketClient({
      chain: foundry,
      url: `ws://127.0.0.1:${port}`,
      reconnectDelayMs: DELAY_MS,
    });
    const delivered: bigint[] = [];
    const errors: Error[] = [];
    const unwatch = getContract({ abi, address, client }).watchEvent.Foo(
      {},
      {
        fromBlock: 10n,
        pollingInterval: 20,
        onLogs: (logs) => delivered.push(...logs.map((l) => l.blockNumber)),
        onError: (error) => errors.push(error),
      },
    );
    await vi.waitFor(() => expect(delivered).toEqual([11n]));

    // A restarted node has no filters; viem alone would re-create the filter
    // from block 10 and deliver block 11 again.
    await node.close();
    await sleep(300);
    node = await startNode({ port, chain });
    await vi.waitFor(() => expect(node.newFilters).toEqual([12n]), {
      timeout: 3_000,
    });
    await sleep(150);
    expect(delivered).toEqual([11n]);

    // A network blip leaves the filters in place, so the superseded poll loop
    // reads block 13 from its old filter before that filter is uninstalled.
    const { filters } = node;
    await node.close();
    chain.head = 13n;
    chain.logs.set(13n, [logAt(13n)]);
    await sleep(300);
    node = await startNode({ port, chain, filters, uninstallDelayMs: 100 });
    await vi.waitFor(() => expect(delivered).toEqual([11n, 13n]), {
      timeout: 3_000,
    });
    await sleep(150);
    expect(delivered).toEqual([11n, 13n]);
    expect(node.newFilters).toEqual([12n]);
    expect(errors).toEqual([]);

    unwatch();
    close();
    await node.close();
  });
});
