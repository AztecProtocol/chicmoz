import { defineConfig } from "vitest/dist/config.js";

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/build/**"],
    // Child processes, not worker threads: on Linux the thread pool exits 1
    // after every test passes (these tests load the Aztec SDK's native
    // modules), failing CI. Reproduced on ubuntu-latest; --no-threads exits 0.
    threads: false,
  },
});
