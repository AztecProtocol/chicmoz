import { defineConfig } from "vitest/config";

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    include: ["src/**/*.prune.ts"],
    pool: "forks",
    maxWorkers: 1,
    // No bail: each scenario plays once in its hook, and every outcome is
    // asserted on its own.
    testTimeout: 60_000,
    // A hook forces a prune, waits for the API to settle, and the prefix
    // scenario then waits on the shorter chain and mines one tx.
    hookTimeout: 300_000,
    server: {
      deps: {
        // As in vitest.smoke.config.ts: an inlined @chicmoz-pkg/types
        // evaluates its import cycle in the wrong order.
        external: [/\/packages\/[^/]+\/build\//],
      },
    },
  },
});
