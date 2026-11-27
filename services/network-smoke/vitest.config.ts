import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
});
