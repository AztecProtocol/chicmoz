import { deliver, loadFixture } from "@chicmoz/test-harness";
import { describe, expect, it, vi } from "vitest";
import type * as Ws from "ws";

type Send = (data: unknown, options?: { binary?: boolean }) => void;
type Client = { readyState: number; send: Send };

const { clients, logger } = vi.hoisted(() => ({
  clients: new Set<Client>(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// init() is the only way to the publisher's private server; handing it a
// server whose clients the test owns keeps the real send path without a port.
vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof Ws>();
  const { EventEmitter } = await import("node:events");
  class TestServer extends EventEmitter {
    clients = clients;
    constructor() {
      super();
      setImmediate(() => this.emit("listening"));
    }
  }
  return { ...actual, WebSocketServer: TestServer };
});
vi.mock("../src/ws-server/health.js", () => ({
  createHealthCheckServer: vi.fn(),
  closeHealthCheckServer: vi.fn(),
}));
vi.mock("../src/logger.js", () => ({ logger }));

vi.stubEnv("L2_NETWORK_ID", "TESTNET");
const { WebSocket } = await import("ws");
const { init } = await import("../src/ws-server/index.js");
const { blockHandler } = await import("../src/event-handler/index.js");

const BLOCK = "block-46977";
// Above 2^53: a JSON number could not carry it exactly.
const TOTAL_FEES = "2388197882111600000";

type BlockFrame = {
  block: {
    height: unknown;
    hash: unknown;
    header: { totalFees: unknown };
    body: { txEffects: { txHash: unknown }[] };
  };
};

// The parsed block holds bigints (height, fees, mana), which plain
// JSON.stringify rejects; only a real block shows every one of them reaching
// the frame. explorer-ui-v2 reads the recorded frame, so it follows this one.
describe("block frame sent to websocket clients", () => {
  it("sends one JSON frame per recorded block, bigints as exact decimal strings", async () => {
    await init();
    const send = vi.fn<Send>();
    clients.add({ readyState: WebSocket.OPEN, send });
    const { data } = loadFixture("testnet", "l2-block", BLOCK);

    await deliver(blockHandler, {
      block: data.hex,
      blockNumber: data.expected.height,
      statusHint: "proposed",
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    const [[frame, options]] = send.mock.calls;
    // The UI ignores binary messages.
    expect(typeof frame).toBe("string");
    expect(options?.binary).not.toBe(true);
    const { block } = JSON.parse(frame as string) as BlockFrame;
    expect(block.height).toBe(String(data.expected.height));
    expect(block.hash).toBe(data.expected.hash);
    expect(block.body.txEffects.map(({ txHash }) => txHash)).toEqual(
      data.expected.txHashes,
    );
    expect(block.header.totalFees).toBe(TOTAL_FEES);
    await expect(frame).toMatchFileSnapshot(`frames/testnet-${BLOCK}.json.snap`);
  });
});
