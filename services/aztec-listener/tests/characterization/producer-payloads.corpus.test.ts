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
import { mockLogger, mockTxsController } from "../mocks/index.js";

const { publish, getL2Tips } = vi.hoisted(() => ({
  publish: vi.fn<(topic: string, payload: unknown) => Promise<void>>(),
  getL2Tips: vi.fn<() => Promise<unknown>>(),
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

vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });
vi.stubEnv("KAFKA_NAMESPACE", "");

type Sent = { topic: string; bytes: Uint8Array };
// `data` is the decoded value; canonicalJson tags it once, for the whole map.
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
const record = async (
  name: string,
  eventType: string,
  run: () => Promise<void> | void,
) => {
  expect(frames, `duplicate case ${name}`).not.toHaveProperty([name]);
  sent.length = 0;
  await run();
  await flush();
  expect(sent, name).toHaveLength(1);
  const [{ topic, bytes }] = sent;
  expect(topic, name).toBe(`SANDBOX__${eventType}`);
  const { data } = BSON.deserialize(bytes) as { data: unknown };
  frames[name] = {
    eventType,
    topic,
    data,
    bson: Buffer.from(bytes).toString("hex"),
  };
};

// A consumer built against the old frames decodes these bytes; a schema-level
// test sees parsed objects, not the topic or what BSON keeps of them.
describe("aztec-listener producer frames", () => {
  it("each producer still publishes one frame with its recorded topic and bytes", async () => {
    const { L2_NETWORK_ID } = await import("../../src/environment.js");
    const { onChainInfo, onL2RpcNodeInfo } = await import(
      "../../src/events/emitted/index.js"
    );
    const { getChicmozChainInfoFromNodeInfo, getRpcNodeFromNodeInfo } =
      await import("../../src/svcs/poller/network-client/utils.js");
    const { setNodeOffline } = await import(
      "../../src/svcs/poller/network-client/pool.js"
    );

    for (const source of FIXTURE_SOURCES) {
      for (const name of listFixtures(source, "node-info")) {
        // The node client parses every result with the node API's schema.
        const nodeInfo = NodeInfoSchema.parse(
          loadFixture(source, "node-info", name).data.result,
        );
        await record(`${source}/chain-info`, "CHAIN_INFO_EVENT", () =>
          onChainInfo(getChicmozChainInfoFromNodeInfo(L2_NETWORK_ID, nodeInfo)),
        );
        await record(`${source}/rpc-node`, "L2_RPC_NODE_INFO_EVENT", () =>
          onL2RpcNodeInfo(
            getRpcNodeFromNodeInfo(L2_NETWORK_ID, RPC_NAME, RPC_URL, nodeInfo),
          ),
        );
      }
    }

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
    await record("rpc-node-error", "L2_RPC_NODE_ERROR_EVENT", () =>
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
        await record(`${source}/l2-tips`, "L2_TIPS_EVENT", async () => {
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
