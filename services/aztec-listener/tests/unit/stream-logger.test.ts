import { describe, expect, it, vi } from "vitest";
import { streamLogger } from "../../src/svcs/poller/pollers/block_poller/stream-logger.js";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({ logger }));

describe("stream logger", () => {
  it("redacts URLs in stream logs", () => {
    streamLogger.error(
      "Error processing block stream",
      new Error(
        "Error fetching from host https://node.example/v1/abc?x=1: fetch failed",
      ),
      { url: "http://192.0.2.1:8080/path" },
    );

    const [line] = logger.error.mock.calls[0] as [string];
    expect(line).toMatch(
      /^Error processing block stream Error: Error fetching from host <url>: fetch failed/,
    );
    expect(line).toContain("url: '<url>'");
    expect(line).not.toMatch(/node\.example|abc|192\.0\.2\.1/);
  });
});
