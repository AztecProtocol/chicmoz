import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("startup config print", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prints each pool entry's name and its URL's origin, marking a path or query", async () => {
    vi.stubEnv(
      "AZTEC_RPC_URLS",
      "keyed::https://operator9:pw456secret@node.example:8443/v1/key123secret?apikey=key789secret,plain::http://127.0.0.1:8080",
    );
    const { getConfigStr } = await import("../../src/environment.js");
    const printed = getConfigStr();

    expect(printed).toContain(
      "Name: keyed\n  URL: https://node.example:8443/…\n",
    );
    expect(printed).toContain("Name: plain\n  URL: http://127.0.0.1:8080\n");
    expect(printed).not.toMatch(
      /operator9|pw456secret|key123secret|key789secret/,
    );
  });
});
