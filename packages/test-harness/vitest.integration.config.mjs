import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/integration-setup.ts"],
    pool: "forks",
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
