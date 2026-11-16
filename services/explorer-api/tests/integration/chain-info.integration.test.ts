import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import { chainInfoEvent as event } from "./support/fixtures.js";

describe("chain info", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  it("is stored by its handler, served by GET /l2/info and cached under the namespace", async () => {
    const { chainInfoHandler } = await import(
      "../../src/events/received/on-chain-info.js"
    );
    await deliver(chainInfoHandler, event);

    const res = await api.request.get("/l2/info");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({
      l2NetworkId: "SANDBOX",
      l1ChainId: 31337,
      l1ContractAddresses: event.chainInfo.l1ContractAddresses,
      protocolContractAddresses: event.chainInfo.protocolContractAddresses,
    });

    const key = `${api.namespace}-SANDBOX-l2-chain-info`;
    expect(
      (await api.stack.exec("redis", ["redis-cli", "EXISTS", key])).trim(),
    ).toBe("1");
  });
});
