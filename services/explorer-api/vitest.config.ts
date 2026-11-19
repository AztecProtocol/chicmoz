import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vitest discovers configuration through a default export.
// eslint-disable-next-line import/no-default-export
export default defineConfig({
  resolve: {
    // Run the harness from source: it is not part of build:packages.
    alias: {
      "@chicmoz/test-harness": fileURLToPath(
        new URL("../../packages/test-harness/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    exclude: ["build/**", "node_modules/**", "**/*.integration.test.ts"],
  },
});
