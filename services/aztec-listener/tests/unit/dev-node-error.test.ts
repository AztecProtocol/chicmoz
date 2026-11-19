import { describe, expect, it, vi } from "vitest";

const publishMessageSync = vi.fn();

vi.mock("@chicmoz-pkg/types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chicmoz-pkg/types")>()),
  NODE_ENV: "development",
}));
vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: vi.fn(),
  publishMessageSync,
}));
vi.mock("../../src/svcs/database/heights.controller.js", () => ({
  ensureInitializedBlockHeights: vi.fn(),
}));
vi.mock("../../src/svcs/poller/network-client/index.js", () => ({
  init: vi.fn().mockResolvedValue({
    chainInfo: {
      l1ChainId: 31337,
      rollupVersion: 1n,
      l1ContractAddresses: {},
      protocolContractAddresses: {},
    },
  }),
}));

describe("development start", () => {
  // Missing either field makes explorer-api's handler fail on every delivery.
  it("publishes a mocked node error carrying the rpcUrl and rpcNodeName explorer-api stores", async () => {
    const { init } = await import("../../src/svcs/poller/index.js");
    await init();

    expect(publishMessageSync).toHaveBeenCalledWith(
      "L2_RPC_NODE_ERROR_EVENT",
      expect.objectContaining({
        nodeError: expect.objectContaining({
          name: "Mocked Node Error",
          rpcNodeName: "mocked-rpc-node",
          rpcUrl: "http://mocked-rpc-node.invalid",
        }) as unknown,
      }) as unknown,
    );
  });
});
