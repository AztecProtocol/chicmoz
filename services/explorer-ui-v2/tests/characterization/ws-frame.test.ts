import { QueryClient } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The hooks import the API client, which reads these at import.
vi.stubEnv("VITE_L2_NETWORK_ID", "SANDBOX");
vi.stubEnv("VITE_API_URL", "https://api.test");
vi.stubEnv("VITE_API_KEY", "dev-api-key");

const { handleWebSocketMessage } = await import(
  "~/hooks/websocket/message-callbacks"
);
const { queryKeyGenerator } = await import("~/hooks/api");

// Written by websocket-event-publisher's block frame test from a recorded
// block, and checked there against what the publisher sends.
const PUBLISHED_BLOCK_FRAME = new URL(
  "../../../websocket-event-publisher/tests/frames/testnet-block-46977.json.snap",
  import.meta.url,
);

// The handler drops a frame it cannot parse or whose keys it does not know,
// without a word, so a change to the publisher's frame would silently stop
// live updates. A hand-written frame here would not follow the publisher.
describe("websocket frames from the publisher", () => {
  it("a published block frame marks the latest-block and block-table queries stale", async () => {
    const queryClient = new QueryClient();
    const views = [
      queryKeyGenerator.latestBlock,
      queryKeyGenerator.latestTableBlocks,
    ];
    for (const key of views) {
      queryClient.setQueryData(key, []);
    }

    await handleWebSocketMessage(
      queryClient,
      readFileSync(PUBLISHED_BLOCK_FRAME, "utf8"),
    );

    expect(
      views.map((key) => queryClient.getQueryState(key)?.isInvalidated),
    ).toEqual([true, true]);
  });
});
