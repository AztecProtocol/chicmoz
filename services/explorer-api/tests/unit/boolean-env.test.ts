import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("boolean env vars", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("PUBLIC_API_KEY", "temporary-api-key");
    vi.stubEnv("L2_NETWORK_ID", "TESTNET");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parseBooleanEnv reads only true/false, defaulting when unset", async () => {
    const { parseBooleanEnv } = await import("../../src/environment.js");

    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv("", false)).toBe(false);
    expect(parseBooleanEnv("false", true)).toBe(false);
    expect(parseBooleanEnv("true", false)).toBe(true);
    expect(() => parseBooleanEnv("yes", false)).toThrow();
  });

  it('turns reconciliation off with "false"', async () => {
    vi.stubEnv("L2_BLOCK_RECONCILIATION_ENABLED", "false");
    vi.stubEnv("L1_GOVERNANCE_URI_RECONCILIATION_ENABLED", "false");

    const env = await import("../../src/environment.js");

    expect(env.L2_BLOCK_RECONCILIATION_ENABLED).toBe(false);
    expect(env.L1_GOVERNANCE_URI_RECONCILIATION_ENABLED).toBe(false);
  });
});
