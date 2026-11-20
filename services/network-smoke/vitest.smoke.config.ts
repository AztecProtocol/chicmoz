import { defineConfig } from "vitest/config";

// Vitest discovers configuration through a default export.
// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    include: ["src/**/*.smoke.ts"],
    pool: "forks",
    // Otherwise Vitest starts a fork per CPU for this one file: gigabytes of
    // idle processes on a large host.
    maxWorkers: 1,
    // The tests share one transaction and build on each other's results.
    bail: 1,
    testTimeout: 240_000,
    hookTimeout: 60_000,
    server: {
      deps: {
        // Load the shared packages with Node's own loader, as the services
        // do. Inlined, @chicmoz-pkg/types evaluates an import cycle in an
        // order that leaves ethAddressSchema undefined inside its schemas.
        external: [/\/packages\/[^/]+\/build\//],
      },
    },
  },
});
