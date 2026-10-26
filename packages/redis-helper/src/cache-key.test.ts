import { describe, expect, it } from "vitest";
import { buildCacheKey, parseCacheNamespace } from "./cache-key.js";

describe("cache keys", () => {
  it("are unchanged without a namespace", () => {
    expect(buildCacheKey(["l2", "chain-info"], "TESTNET", undefined)).toBe(
      "TESTNET-l2-chain-info",
    );
  });

  it("keep two deployments of one network apart", () => {
    const v5 = buildCacheKey(["l2", "blocks", 42n], "TESTNET", undefined);
    const v6 = buildCacheKey(["l2", "blocks", 42n], "TESTNET", "v6");
    expect(v6).toBe("v6-TESTNET-l2-blocks-42");
    expect(v6).not.toBe(v5);
  });

  it("read the namespace from KAFKA_NAMESPACE's rules", () => {
    expect(parseCacheNamespace(undefined)).toBeUndefined();
    expect(parseCacheNamespace("")).toBeUndefined();
    expect(parseCacheNamespace("v6")).toBe("v6");
    expect(() => parseCacheNamespace("v6-x")).toThrow();
  });
});
