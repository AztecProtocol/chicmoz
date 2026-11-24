import { once } from "node:events";
import { type IncomingMessage, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { GovernanceAbi, RegistryAbi } from "@aztec-foundation/l1-artifacts";
import { loadFixture } from "@chicmoz/test-harness";
import {
  type Hex,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  getContract,
  pad,
  parseAbi,
  toHex,
} from "viem";
import { foundry } from "viem/chains";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createWebSocketClient } from "../src/network-client/client/web-socket-client.js";

const seam = vi.hoisted(() => {
  vi.stubEnv("L2_NETWORK_ID", "TESTNET");
  vi.stubEnv("KAFKA_NAMESPACE", undefined);
  return {
    addresses: {} as Record<string, unknown>,
    /** The stored row of every event, or none. */
    heights: undefined as
      | { latestPendingHeight: bigint; latestFinalizedHeight: bigint }
      | undefined,
    published: [] as { topic: string; payload: Record<string, unknown> }[],
  };
});

vi.mock("@chicmoz-pkg/message-bus", () => ({
  publishMessage: (topic: string, payload: Record<string, unknown>) => {
    seam.published.push({ topic, payload });
    return Promise.resolve();
  },
  generateSvc: () => ({}),
  startSubscribe: () => Promise.resolve(),
}));
vi.mock("@chicmoz-pkg/postgres-helper", async () => {
  const { getTableName } = await import("drizzle-orm");
  type Table = Parameters<typeof getTableName>[0];
  return {
    generateSvc: () => ({}),
    getDb: () => ({
      select: () => ({
        from: (table: Table) => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                getTableName(table) === "l1ContractAddresses"
                  ? [{ addresses: seam.addresses }]
                  : seam.heights
                    ? [seam.heights]
                    : [],
              ),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
      }),
    }),
  };
});
vi.mock("../src/logger.js", () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

afterAll(() => {
  vi.unstubAllEnvs();
});

// viem's default polling interval and block-number cache time, kept by the L1 clients.
const CLIENT_POLL_MS = 4_000;
// Real time that a test can also jump forward.
const useJumpingClock = () =>
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "clearTimeout", "Date"],
  });
afterEach(() => {
  vi.useRealTimers();
});

const MAX_RANGE = 1_000n; // blocks per eth_getLogs the node accepts
const FINALITY_LAG = 64n;

type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed: false;
};
type Chain = {
  head: bigint;
  logs: RawLog[];
  /** eth_call results by lowercase target address. */
  calls?: Record<string, Hex>;
};
type Range = { fromBlock: bigint; toBlock: bigint };

const oversized = (ranges: Range[]) =>
  ranges.filter(
    ({ fromBlock, toBlock }) => toBlock - fromBlock + 1n > MAX_RANGE,
  );

/**
 * JSON-RPC over HTTP and WebSocket on one port, without filters, refusing
 * eth_getLogs ranges above MAX_RANGE with a code viem does not retry.
 */
const startNode = async (chain: Chain, port = 0) => {
  const getLogs: Range[] = [];
  const newFilters: unknown[] = [];
  const answer = (
    method: string,
    params: unknown[] = [],
  ): { result: unknown } | { error: { code: number; message: string } } => {
    const [first] = params;
    switch (method) {
      case "eth_blockNumber":
        return { result: toHex(chain.head) };
      case "eth_getBlockByNumber": {
        const n =
          first === "finalized"
            ? chain.head - FINALITY_LAG
            : BigInt(first as Hex);
        return {
          result: {
            number: toHex(n),
            hash: pad(toHex(n), { size: 32 }),
            timestamp: toHex(1_700_000_000n + n * 12n),
          },
        };
      }
      case "eth_call": {
        const result =
          chain.calls?.[(first as { to: string }).to.toLowerCase()];
        return result
          ? { result }
          : { error: { code: -32000, message: "execution reverted" } };
      }
      case "eth_newFilter":
        newFilters.push(first);
        return { error: { code: -32601, message: "method not supported" } };
      case "eth_getLogs": {
        const filter = first as {
          address: Hex;
          topics: (Hex | null)[];
          fromBlock: Hex;
          toBlock: Hex;
        };
        const range = {
          fromBlock: BigInt(filter.fromBlock),
          toBlock: BigInt(filter.toBlock),
        };
        getLogs.push(range);
        if (oversized([range]).length) {
          return {
            error: {
              code: -32602,
              message: `exceed maximum block range: ${MAX_RANGE}`,
            },
          };
        }
        return {
          result: chain.logs.filter(
            (log) =>
              log.address.toLowerCase() === filter.address.toLowerCase() &&
              log.topics[0] === filter.topics[0] &&
              BigInt(log.blockNumber) >= range.fromBlock &&
              BigInt(log.blockNumber) <= range.toBlock,
          ),
        };
      }
      default:
        return { error: { code: -32601, message: `unexpected ${method}` } };
    }
  };
  const reply = (raw: string) => {
    const { id, method, params } = JSON.parse(raw) as {
      id: number;
      method: string;
      params?: unknown[];
    };
    return JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params) });
  };
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString();
  };
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      res.setHeader("content-type", "application/json");
      res.end(reply(raw));
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(reply(String(data))));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    getLogs,
    newFilters,
    close: async () => {
      wss.clients.forEach((client) => client.terminate());
      wss.close();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

describe("live watcher eth_getLogs ranges", () => {
  // Catches a watcher that starts at its stored pending height (genesis when
  // none was stored) and asks for that range on every poll.
  it("startContractWatchers starts every watcher after the finalized block when no pending height was stored", async () => {
    const ADDRESSES = loadFixture("testnet", "node-info", "node-info").data
      .result.l1ContractAddresses;
    const address = (name: keyof typeof ADDRESSES) =>
      getAddress(String(ADDRESSES[name]));
    const { log } = loadFixture(
      "testnet",
      "l1-log",
      "checkpoint-proposed-33600",
    ).data;
    // The recorded proposal is in the last, unfinalized blocks.
    const head = log.blockNumber + 2n;
    const node = await startNode({
      head,
      logs: [
        {
          address: log.address as Hex,
          topics: log.topics as Hex[],
          data: log.data as Hex,
          blockNumber: toHex(log.blockNumber),
          blockHash: log.blockHash as Hex,
          transactionHash: log.transactionHash as Hex,
          transactionIndex: toHex(log.transactionIndex),
          logIndex: toHex(log.logIndex),
          removed: false,
        },
      ],
      calls: {
        [address("registryAddress").toLowerCase()]: encodeFunctionResult({
          abi: RegistryAbi,
          functionName: "getGovernance",
          result: address("governanceAddress"),
        }),
        [address("governanceAddress").toLowerCase()]: encodeFunctionResult({
          abi: GovernanceAbi,
          functionName: "governanceProposer",
          result: address("governanceProposerAddress"),
        }),
      },
    });
    vi.stubEnv("ETHEREUM_HTTP_RPC_URL", `http://127.0.0.1:${node.port}`);
    vi.stubEnv("ETHEREUM_WS_RPC_URL", `ws://127.0.0.1:${node.port}`);
    // Imported after the stubs: the environment is read at import.
    const { initClient } = await import(
      "../src/network-client/client/index.js"
    );
    const { startContractWatchers } = await import(
      "../src/network-client/contracts/index.js"
    );
    seam.addresses = ADDRESSES;
    // The poller's insert leaves the pending height at its default, 0.
    seam.heights = {
      latestPendingHeight: 0n,
      latestFinalizedHeight: head - 20_000n,
    };
    useJumpingClock();
    initClient();
    const unwatch = await startContractWatchers();
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS);

    // Every watcher has made its first eth_getLogs after its first filter attempt.
    await vi.waitFor(
      () =>
        expect(node.getLogs.length).toBeGreaterThanOrEqual(
          node.newFilters.length,
        ),
      { timeout: 10_000, interval: 50 },
    );
    expect(node.newFilters.length).toBeGreaterThan(1);
    expect(oversized(node.getLogs)).toEqual([]);
    await vi.waitFor(() =>
      expect(
        seam.published
          .filter(({ topic }) => topic.endsWith("L1_L2_BLOCK_PROPOSED_EVENT"))
          .map(({ payload }) => [payload.l2BlockNumber, payload.isFinalized]),
      ).toEqual([["33600", false]]),
    );
    unwatch();
    await node.close();
  }, 20_000);

  // Catches a restart from the last delivered block, or from the original
  // fromBlock, after the chain has moved further than one request may span,
  // and a restart from the finalized block when the watcher is already past it.
  it("a watcher restarted after an outage resumes after the later of its last delivered block and the finalized block", async () => {
    const abi = parseAbi(["event Foo(uint256 indexed x)"]);
    const [delivering, quiet] = [
      "0x00000000000000000000000000000000000000aa",
      "0x00000000000000000000000000000000000000bb",
    ] as const;
    const logAt = (address: Hex, block: bigint): RawLog => ({
      address,
      topics: encodeEventTopics({
        abi,
        eventName: "Foo",
        args: { x: block },
      }) as Hex[],
      data: "0x",
      blockNumber: toHex(block),
      blockHash: pad(toHex(block), { size: 32 }),
      transactionHash: pad(toHex(block), { size: 32 }),
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    });
    useJumpingClock();
    const chain: Chain = { head: 1_000n, logs: [logAt(delivering, 990n)] };
    let node = await startNode(chain);
    const { client, close } = createWebSocketClient({
      chain: foundry,
      url: `ws://127.0.0.1:${node.port}`,
      reconnectDelayMs: 50,
    });
    const delivered: string[] = [];
    const unwatches = [delivering, quiet].map((address) =>
      getContract({ abi, address, client }).watchEvent.Foo(
        {},
        {
          fromBlock: chain.head - FINALITY_LAG + 1n,
          pollingInterval: 20,
          onLogs: (logs) =>
            delivered.push(...logs.map((l) => `${l.address}@${l.blockNumber}`)),
        },
      ),
    );
    await vi.waitFor(() => expect(delivered).toEqual([`${delivering}@990`]));

    // A short outage leaves the finalized block below block 990: the watcher
    // keeps its position, so a restart from the finalized block would deliver
    // block 990 twice.
    await node.close();
    chain.head += 10n;
    const blip = chain.head;
    chain.logs.push(logAt(delivering, blip));
    node = await startNode(chain, node.port);
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS);
    await vi.waitFor(
      () =>
        expect(delivered).toEqual([
          `${delivering}@990`,
          `${delivering}@${blip}`,
        ]),
      { timeout: 3_000 },
    );

    await node.close();
    chain.head += 5n * MAX_RANGE;
    const tip = chain.head;
    chain.logs.push(
      logAt(delivering, tip - 2n * FINALITY_LAG), // finalized during the outage
      logAt(delivering, tip),
      logAt(quiet, tip),
    );
    node = await startNode(chain, node.port);
    // Expires the block number cached before the outage.
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS);

    await vi.waitFor(
      () =>
        expect([...delivered].sort()).toEqual(
          [
            `${delivering}@990`,
            `${delivering}@${blip}`,
            `${delivering}@${tip}`,
            `${quiet}@${tip}`,
          ].sort(),
        ),
      { timeout: 3_000 },
    );
    unwatches.forEach((unwatch) => unwatch());
    close();
    await node.close();
  });
});
