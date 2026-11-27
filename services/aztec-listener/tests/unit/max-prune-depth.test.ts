import { CHAIN_WALK_BOUND } from "@chicmoz-pkg/message-registry";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("AZTEC_MAX_PRUNE_DEPTH", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Each import evaluates the environment module afresh, which can take
  // seconds on a loaded host.
  it("defaults to the chain walk bound and refuses a depth past it", async () => {
    vi.stubEnv("AZTEC_MAX_PRUNE_DEPTH", undefined);
    const { AZTEC_MAX_PRUNE_DEPTH } = await import("../../src/environment.js");
    expect(AZTEC_MAX_PRUNE_DEPTH).toBe(CHAIN_WALK_BOUND);

    vi.resetModules();
    vi.stubEnv("AZTEC_MAX_PRUNE_DEPTH", String(CHAIN_WALK_BOUND + 1));
    await expect(import("../../src/environment.js")).rejects.toMatchObject({
      issues: [{ code: "too_big", maximum: CHAIN_WALK_BOUND }],
    });
  }, 30_000);
});
