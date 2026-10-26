import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("boolean env vars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parseBooleanEnv reads only true/false, defaulting when unset", async () => {
    const { parseBooleanEnv } = await import("../../src/environment.js");

    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv("", false)).toBe(false);
    expect(parseBooleanEnv("false", true)).toBe(false);
    expect(parseBooleanEnv("true", false)).toBe(true);
    expect(() => parseBooleanEnv("0", true)).toThrow();
  });

  it('turns listeners off with "false" and keeps Aztec enabled', async () => {
    process.env.AZTEC_LISTEN_FOR_PENDING_TXS = "false";
    process.env.AZTEC_LISTEN_FOR_CHAIN_INFO = "false";
    process.env.AZTEC_LISTEN_FOR_L2_TIPS = "false";
    process.env.AZTEC_DISABLED = "false";

    const env = await import("../../src/environment.js");

    expect(env.AZTEC_LISTEN_FOR_PENDING_TXS).toBe(false);
    expect(env.AZTEC_LISTEN_FOR_CHAIN_INFO).toBe(false);
    expect(env.AZTEC_LISTEN_FOR_L2_TIPS).toBe(false);
    expect(env.AZTEC_DISABLED).toBe(false);
  });
});
