import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { L2TipsSchema } from "@aztec-labs/stdlib/block";
import { NodeInfoSchema } from "@aztec-labs/stdlib/contract";
import {
  FIXTURE_SOURCES,
  canonicalJson,
  listFixtures,
  loadFixture,
} from "@chicmoz/test-harness";
import { BSON } from "bson";
import { describe, expect, it, vi } from "vitest";
import type * as NetworkClient from "../../src/svcs/poller/network-client/index.js";
import type * as Pool from "../../src/svcs/poller/network-client/pool.js";
import { mockLogger, mockTxsController } from "../mocks/index.js";

const { publish, getL2Tips, pool } = vi.hoisted(() => ({
  publish: vi.fn<(topic: string, payload: unknown) => Promise<void>>(),
  getL2Tips: vi.fn<() => Promise<unknown>>(),
  pool: { nodes: [] as Pool.RpcNode[] },
}));

vi.mock("@chicmoz-pkg/message-bus", () => ({
  publishMessage: publish,
  generateSvc: vi.fn(),
  startSubscribe: vi.fn(),
}));
vi.mock("../../src/svcs/database/index.js", () => ({
  txsController: mockTxsController,
}));
vi.mock("../../src/logger.js", () => ({ logger: mockLogger }));
vi.mock("../../src/svcs/poller/network-client/index.js", () => ({
  getL2Tips,
}));
vi.mock(
  "../../src/svcs/poller/network-client/pool.js",
  async (importOriginal) => ({
    ...(await importOriginal<typeof Pool>()),
    getAllRpcNodes: () => pool.nodes,
    getAmountOfOnlineNodes: () => pool.nodes.length,
  }),
);

vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });
vi.stubEnv("KAFKA_NAMESPACE", "");

type Sent = { topic: string; bytes: Uint8Array };
type Frame = { eventType: string; topic: string; data: unknown; bson: string };

const sent: Sent[] = [];
publish.mockImplementation((topic, payload) => {
  // Exactly what MessageBus.publish puts in the Kafka message value.
  sent.push({ topic, bytes: BSON.serialize({ data: payload }) });
  return Promise.resolve();
});

const RPC_NAME = "rpc-example";
const RPC_URL = "https://rpc.example.org";

const flush = () => new Promise((resolve) => setImmediate(resolve));

const frames: Record<string, Frame> = {};
// `cases` maps each frame name to an event type the run publishes exactly once.
const record = async (cases: Record<string, string>, run: () => unknown) => {
  const expected = Object.entries(cases).map(([name, eventType]) => ({
    name,
    eventType,
    topic: `SANDBOX__${eventType}`,
  }));
  sent.length = 0;
  await run();
  // The alive event leaves through a Bottleneck queue a few macrotasks later.
  for (let tries = 0; sent.length < expected.length && tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await flush();
  expect(sent.map(({ topic }) => topic).sort()).toEqual(
    expected.map(({ topic }) => topic).sort(),
  );
  for (const { name, eventType, topic } of expected) {
    expect(frames, `duplicate case ${name}`).not.toHaveProperty([name]);
    const [{ bytes }] = sent.filter((frame) => frame.topic === topic);
    const { data } = BSON.deserialize(bytes) as { data: unknown };
    frames[name] = {
      eventType,
      topic,
      data,
      bson: Buffer.from(bytes).toString("hex"),
    };
  }
};

// A consumer built against the old frames decodes these bytes; a schema-level
// test sees parsed objects, not the topic or what BSON keeps of them.
describe("aztec-listener producer frames", () => {
  it("each producer still publishes its frames with the recorded topics and bytes", async () => {
    // getFreshInfo rebuilds the node's answer and decides what to publish for
    // which node, so the converters alone would not show what leaves it.
    for (const source of FIXTURE_SOURCES) {
      for (const name of listFixtures(source, "node-info")) {
        // The alive event is throttled per URL for a module's lifetime, and a
        // mocked path keeps its first instance across resetModules.
        vi.resetModules();
        const { getFreshInfo } = await vi.importActual<typeof NetworkClient>(
          "../../src/svcs/poller/network-client/index.js",
        );
        const instance = createAztecNodeClient(RPC_URL);
        // The node client parses every result with the node API's schema.
        vi.spyOn(instance, "getNodeInfo").mockResolvedValue(
          NodeInfoSchema.parse(
            loadFixture(source, "node-info", name).data.result,
          ),
        );
        pool.nodes = [{ name: RPC_NAME, url: RPC_URL, instance }];
        await record(
          {
            [`${source}/chain-info`]: "CHAIN_INFO_EVENT",
            [`${source}/rpc-node`]: "L2_RPC_NODE_INFO_EVENT",
            [`${source}/rpc-node-alive`]: "L2_RPC_NODE_ALIVE_EVENT",
          },
          getFreshInfo,
        );
      }
    }

    const { setNodeOffline } = await import(
      "../../src/svcs/poller/network-client/pool.js"
    );
    const error = new Error("request to http://192.0.2.10:8080/ failed", {
      cause: { message: "Service Unavailable: http://192.0.2.10:8080/" },
    });
    error.stack =
      "Error: request to http://192.0.2.10:8080/ failed\n    at http://192.0.2.10:8080/";
    const node = {
      name: RPC_NAME,
      url: RPC_URL,
      instance: createAztecNodeClient(RPC_URL),
    };
    await record({ "rpc-node-error": "L2_RPC_NODE_ERROR_EVENT" }, () =>
      setNodeOffline(node, "getBlock", error, [
        BlockNumber(46972),
        { includeTransactions: true },
      ]),
    );

    for (const source of FIXTURE_SOURCES) {
      for (const name of listFixtures(source, "l2-tips")) {
        // The poller skips tips equal to the last ones it published.
        vi.resetModules();
        const poller = await import(
          "../../src/svcs/poller/pollers/l2-tips-poller.js"
        );
        getL2Tips.mockResolvedValueOnce(
          L2TipsSchema.parse(loadFixture(source, "l2-tips", name).data.result),
        );
        mockLogger.error.mockClear();
        await record({ [`${source}/l2-tips`]: "L2_TIPS_EVENT" }, async () => {
          poller.startPolling();
          await flush();
          poller.stopPolling();
          // The poller logs a failed poll instead of throwing.
          expect(mockLogger.error).not.toHaveBeenCalled();
        });
      }
    }

    await expect(canonicalJson(frames)).toMatchFileSnapshot(
      "__snapshots__/producer-frames.json.snap",
    );
  });
});
