import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Kafka namespace", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves topic and consumer-group names unchanged when unset", async () => {
    vi.stubEnv("KAFKA_NAMESPACE", "");
    const registry = await import("./index.js");

    expect(registry.generateL2TopicName("TESTNET", "NEW_BLOCK_EVENT")).toBe(
      "TESTNET__NEW_BLOCK_EVENT",
    );
    expect(
      registry.generateL1TopicName(
        "TESTNET",
        "ETH_SEPOLIA",
        "L1_GOVERNANCE_URI_REQUEST_EVENT",
      ),
    ).toBe("TESTNET_ETH_SEPOLIA__L1_GOVERNANCE_URI_REQUEST_EVENT");
    expect(
      registry.getConsumerGroupId({
        serviceName: "explorer-api",
        networkId: "TESTNET",
        handlerName: "blockHandler",
      }),
    ).toBe("explorer-api_TESTNET_blockHandler");
  });

  it("prefixes every topic and consumer group when set", async () => {
    vi.stubEnv("KAFKA_NAMESPACE", "v6");
    const registry = await import("./index.js");

    expect(registry.generateL2TopicName("TESTNET", "NEW_BLOCK_EVENT")).toBe(
      "v6.TESTNET__NEW_BLOCK_EVENT",
    );
    expect(
      registry.generateL1TopicName(
        "TESTNET",
        "ETH_SEPOLIA",
        "L1_GOVERNANCE_URI_REQUEST_EVENT",
      ),
    ).toBe("v6.TESTNET_ETH_SEPOLIA__L1_GOVERNANCE_URI_REQUEST_EVENT");
    expect(
      registry.getConsumerGroupId({
        serviceName: "explorer-api",
        networkId: "TESTNET",
        handlerName: "blockHandler",
      }),
    ).toBe("v6.explorer-api_TESTNET_blockHandler");
  });

  it("rejects a namespace Kafka names could not carry safely", async () => {
    const { parseKafkaNamespace } = await import("./namespace.js");

    expect(parseKafkaNamespace(undefined)).toBeUndefined();
    expect(parseKafkaNamespace("v6")).toBe("v6");
    expect(() => parseKafkaNamespace("v6.testnet")).toThrow();
    expect(() => parseKafkaNamespace("v 6")).toThrow();
  });
});
