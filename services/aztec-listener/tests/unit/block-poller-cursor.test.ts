import { afterEach, describe, expect, it, vi } from "vitest";

const node = vi.hoisted(() => ({
  tip: 5,
  processedProposed: 5,
  failOnce: new Set<number>(),
  delivered: [] as number[],
  pollsFinished: 0,
}));

vi.mock("../../src/environment.js", () => ({
  AZTEC_ENABLE_FULL_SWEEP_CATCHUP: false,
  AZTEC_DISABLE_LISTEN_FOR_PROPOSED_BLOCKS: false,
  AZTEC_DISABLE_LISTEN_FOR_PROVEN_BLOCKS: false,
  BLOCK_POLL_INTERVAL_MS: 60_000,
  CATCHUP_POLL_WAIT_TIME_MS: 0,
}));
vi.mock("../../src/logger.js", () => ({
  logger: {
    debug: () => undefined,
    info: (message: string) => {
      if (message.startsWith("🐱 waiting")) {
        node.pollsFinished++;
      }
    },
    warn: () => undefined,
    error: () => undefined,
  },
}));
vi.mock("../../src/svcs/database/heights.controller.js", () => ({
  getBlockHeights: () =>
    Promise.resolve({
      processedProposedBlockHeight: node.processedProposed,
      processedProvenBlockHeight: 5,
      chainProposedBlockHeight: 0,
      chainProvenBlockHeight: 0,
    }),
  storeBlockHeights: (heights: { processedProposedBlockHeight: number }) => {
    node.processedProposed = heights.processedProposedBlockHeight;
    return Promise.resolve();
  },
  storeProcessedProposedBlockHeight: (height: number) => {
    node.processedProposed = height;
    return Promise.resolve();
  },
  storeProcessedProvenBlockHeight: () => Promise.resolve(),
}));
vi.mock("../../src/svcs/poller/network-client/index.js", () => ({
  getBlock: (height: number) => Promise.resolve({ height }),
  getLatestProposedHeight: () => Promise.resolve(node.tip),
  getLatestProvenHeight: () => Promise.resolve(5),
}));
vi.mock("../../src/events/emitted/index.js", () => ({
  onBlock: ({ height }: { height: number }) => {
    if (node.failOnce.delete(height)) {
      return Promise.reject(new Error("publish rejected"));
    }
    node.delivered.push(height);
    return Promise.resolve();
  },
  onCatchupBlock: () => Promise.resolve(),
}));
vi.mock(
  "../../src/svcs/poller/pollers/block_poller/handle-proven-block-txs.js",
  () => ({ handleProvenTransactions: () => Promise.resolve() }),
);

afterEach(() => {
  vi.useRealTimers();
});

// A cursor stored past a block whose publish failed leaves that block to
// reconciliation; only the real poll loop shows the store follows the publish.
describe("block poller cursor", () => {
  it("re-polls a proposed block whose publish failed before marking it processed", async () => {
    vi.useFakeTimers();
    const poller = await import(
      "../../src/svcs/poller/pollers/block_poller/index.js"
    );
    const pollFinished = (count: number) =>
      vi.waitFor(() => expect(node.pollsFinished).toBe(count));

    poller.startPolling(); // the first poll is a catch-up run; nothing to do
    try {
      await pollFinished(1);
      node.tip = 7;
      node.failOnce.add(6);
      await vi.advanceTimersByTimeAsync(60_000);
      await pollFinished(2);
      expect(node.processedProposed).toBe(5);
      await vi.advanceTimersByTimeAsync(60_000);
      await pollFinished(3);
    } finally {
      poller.stopPolling();
    }

    expect(node.delivered).toEqual([6, 7]);
    expect(node.processedProposed).toBe(7);
  });
});
