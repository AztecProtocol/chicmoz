import { defineConfig } from "vitest/config";

// Vitest discovers configuration through a default export.
// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    include: ["src/**/*.scripted.ts"],
    pool: "forks",
    maxWorkers: 1,
    // No bail: the scenario plays once in the hook, and every outcome is
    // asserted on its own.
    testTimeout: 60_000,
    // The hook plays the whole script and waits for the API to settle.
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
