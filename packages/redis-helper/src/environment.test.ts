import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("REDIS_PORT", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("L2_NETWORK_ID", "SANDBOX");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 6379 when unset", async () => {
    vi.stubEnv("REDIS_PORT", undefined);
    const { REDIS_PORT } = await import("./environment.js");
    expect(REDIS_PORT).toBe(6379);
  });

  it("reads a port from the environment string", async () => {
    vi.stubEnv("REDIS_PORT", "6380");
    const { REDIS_PORT } = await import("./environment.js");
    expect(REDIS_PORT).toBe(6380);
  });

  it("rejects a value that is not a port number", async () => {
    vi.stubEnv("REDIS_PORT", "abc");
    await expect(import("./environment.js")).rejects.toThrow();
  });
});
