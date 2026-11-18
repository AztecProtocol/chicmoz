import { defineConfig } from "vitest/config";

// Vitest discovers configuration through a default export.
// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    exclude: ["build/**", "node_modules/**"],
    // environment.ts parses these at import.
    env: { L2_NETWORK_ID: "SANDBOX" },
  },
});
