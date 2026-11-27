import { describe, expect, it, vi } from "vitest";
import { readLatestRollupVersion } from "../../src/svcs/poller/network-client/rollup-version.js";
import { FakeNode, genesisChain } from "./support/chain.js";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/events/emitted/index.js", () => ({
  onChainInfo: vi.fn(),
  onL2RpcNodeAlive: vi.fn(),
  onL2RpcNodeError: vi.fn(),
  onL2RpcNodeInfo: vi.fn(),
}));

describe("readLatestRollupVersion", () => {
  it("names the highest version a node reports in time, with that node, or none when no node answers", async () => {
    const chain = await genesisChain();
    const [low, high, failing, hanging] = [
      "low",
      "high",
      "failing",
      "hanging",
    ].map((name) => new FakeNode(name, chain));
    low.rollupVersion = 7;
    high.rollupVersion = 9;
    failing.getNodeInfo = () => Promise.reject(new Error("connection refused"));
    // Never answers, so the deadline ends its read.
    hanging.getNodeInfo = () => new Promise<never>(() => undefined);

    expect(
      await readLatestRollupVersion(
        [low, high, failing, hanging].map((n) => n.rpc),
        50,
      ),
    ).toEqual({ node: high.rpc, version: 9 });
    expect(
      await readLatestRollupVersion([failing.rpc, hanging.rpc], 50),
    ).toBeUndefined();
  });
});
