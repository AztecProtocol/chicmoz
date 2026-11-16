import { defineConfig } from "vitest/config";

// Vitest discovers configuration through a default export.
// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/integration-setup.ts"],
    pool: "forks",
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
