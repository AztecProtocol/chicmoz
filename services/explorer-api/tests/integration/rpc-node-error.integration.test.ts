import { deliver } from "@chicmoz/test-harness";
import { type ChicmozL2RpcNodeErrorEvent } from "@chicmoz-pkg/message-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

// The shape aztec-listener publishes for its development-mode node error.
const event: ChicmozL2RpcNodeErrorEvent = {
  nodeError: {
    name: "Mocked Node Error",
    message: "Lorem ipsum dolor sit amet",
    cause: "UnknownCause",
    stack: "Error\n    at init (poller/index.ts:22:5)",
    data: {},
    rpcNodeName: "mocked-rpc-node",
    rpcUrl: "http://mocked-rpc-node.invalid",
    count: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
  },
};

describe("rpc node error", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  it("is stored by its handler and a repeat of it is counted", async () => {
    const { l2RpcNodeErrorHandler } = await import(
      "../../src/events/received/on-l2-rpc-node.js"
    );
    const { controllers } = await import("../../src/svcs/database/index.js");

    await deliver(l2RpcNodeErrorHandler, event);
    await deliver(l2RpcNodeErrorHandler, event);

    expect(await controllers.l2.getL2RpcNodeErrors()).toEqual([
      expect.objectContaining({
        name: "Mocked Node Error",
        rpcNodeName: "mocked-rpc-node",
        count: 2,
      }),
    ]);
  });
});
