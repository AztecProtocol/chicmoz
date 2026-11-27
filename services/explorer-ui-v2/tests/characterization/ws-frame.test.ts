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

const TX = `0x${"cd".repeat(32)}`;
// Views a prune can change: the reorg lists, and block and tx details by
// height and by hash.
const CHAIN_VIEWS = [
  queryKeyGenerator.reorgs,
  queryKeyGenerator.orphanedBlocks,
  queryKeyGenerator.blockByHeight("7"),
  queryKeyGenerator.blockByHeight(`0x${"ab".repeat(32)}`),
  queryKeyGenerator.txEffectsByBlockHeight(7),
  queryKeyGenerator.txEffectByHash(TX),
  queryKeyGenerator.pendingTxsByHash(TX),
  queryKeyGenerator.droppedTxByHash(TX),
];
// A block frame says nothing about it.
const UNRELATED = queryKeyGenerator.averageFees;

const staleAfter = async (frame: string, views: unknown[][]) => {
  const queryClient = new QueryClient();
  for (const key of [...views, UNRELATED]) {
    queryClient.setQueryData(key, []);
  }
  await handleWebSocketMessage(queryClient, frame);
  return {
    views: views.map((key) => queryClient.getQueryState(key)?.isInvalidated),
    unrelated: queryClient.getQueryState(UNRELATED)?.isInvalidated,
  };
};

// The handler drops a frame it cannot parse or whose keys it does not know,
// without a word, so a change to the publisher's frame would silently stop
// live updates. A hand-written frame here would not follow the publisher.
describe("websocket frames from the publisher", () => {
  it("a published block frame marks the latest-block, block-table and chain detail queries stale", async () => {
    const views = [
      queryKeyGenerator.latestBlock,
      queryKeyGenerator.latestTableBlocks,
      ...CHAIN_VIEWS,
    ];

    expect(
      await staleAfter(readFileSync(PUBLISHED_BLOCK_FRAME, "utf8"), views),
    ).toEqual({ views: views.map(() => true), unrelated: false });
  });

  // No publisher test records a tips frame. The publisher sends `{ l2Tips }`
  // (`sendL2TipsToClients`), and the handler reads only that key.
  it("a tips frame marks the reorg lists and the chain detail queries stale", async () => {
    expect(
      await staleAfter(JSON.stringify({ l2Tips: {} }), CHAIN_VIEWS),
    ).toEqual({ views: CHAIN_VIEWS.map(() => true), unrelated: false });
  });
});
