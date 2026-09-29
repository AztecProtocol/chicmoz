import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/environment.js", () => ({
  L2_NETWORK_ID: "SANDBOX",
  L2_BLOCK_RANGE_REQUEST_MAX_AGE_MS: 60 * 60 * 1000,
  L2_BLOCK_RANGE_REQUEST_MAX_BLOCKS: 500,
  L2_BLOCK_RANGE_REQUEST_MAX_RANGES: 2,
  L2_BLOCK_RANGE_REQUEST_MAX_WIDTH: 10,
  L2_BLOCK_RANGE_REQUEST_QUEUE_HIGH_WATER: 10,
  L2_BLOCK_RANGE_REQUEST_QUEUE_MIN_TIME_MS: 0,
}));

vi.mock("../../src/events/emitted/index.js", () => ({
  onCatchupBlock: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const pinnedNode = vi.hoisted(() => ({ name: "pinned", url: "http://pinned" }));

vi.mock("../../src/svcs/poller/network-client/index.js", () => ({
  getBlock: vi.fn(),
  getLatestProposedHeight: vi.fn(),
  getLatestProvenHeight: vi.fn(),
  pinRpcNode: vi.fn(() => pinnedNode),
}));

const {
  clampRangeRequest,
  getL2BlockRangeRequestDedupKey,
  l2BlockRangeRequestHandler,
} = await import("../../src/events/received/on-l2-block-range-request.js");
const { onCatchupBlock } = await import("../../src/events/emitted/index.js");
const networkClient = await import(
  "../../src/svcs/poller/network-client/index.js"
);

describe("L2 block range request helpers", () => {
  it("clamps ranges to max width and chain tips", () => {
    const result = clampRangeRequest({
      proposedHeight: 42,
      provenHeight: 20,
      event: {
        requestId: "request-1",
        requestedAt: Date.now(),
        reason: "cadence",
        ranges: [
          { from: 5, to: 100, statusHint: "proposed" },
          { from: 15, to: 50, statusHint: "proven" },
        ],
      },
    });

    expect(result.clampedRanges).toEqual([
      { from: 5, to: 14, statusHint: "proposed" },
      { from: 15, to: 20, statusHint: "proven" },
    ]);
    expect(result.invalidRanges).toEqual([]);
    expect(result.skippedRangeCount).toBe(0);
  });

  it("caps range count and reports invalid ranges", () => {
    const result = clampRangeRequest({
      proposedHeight: 10,
      provenHeight: 10,
      event: {
        requestId: "request-2",
        requestedAt: Date.now(),
        reason: "startup",
        ranges: [
          { from: 12, to: 13 },
          { from: 1, to: 2 },
          { from: 3, to: 4 },
        ],
      },
    });

    expect(result.clampedRanges).toEqual([{ from: 1, to: 2, statusHint: "proposed" }]);
    expect(result.invalidRanges).toEqual([{ from: 12, to: 13 }]);
    expect(result.skippedRangeCount).toBe(1);
  });

  it("builds a network-scoped deduplication key independent of request id", () => {
    const first = getL2BlockRangeRequestDedupKey({
      requestId: "a",
      requestedAt: 1,
      reason: "cadence",
      ranges: [{ from: 1, to: 3 }],
    });
    const second = getL2BlockRangeRequestDedupKey({
      requestId: "b",
      requestedAt: 2,
      reason: "cadence",
      ranges: [{ from: 1, to: 3, statusHint: "proposed" }],
    });

    expect(first).toBe(second);
    expect(first).toBe("SANDBOX:cadence:1-3-proposed");
  });

  it("labels catch-up blocks at or below the proven tip as proven", async () => {
    vi.mocked(networkClient.getLatestProposedHeight).mockResolvedValue(30 as never);
    vi.mocked(networkClient.getLatestProvenHeight).mockResolvedValue(20 as never);
    vi.mocked(networkClient.getBlock).mockImplementation(
      (height: number) =>
        Promise.resolve({ height } as unknown as Awaited<
          ReturnType<typeof networkClient.getBlock>
        >),
    );
    vi.mocked(onCatchupBlock).mockClear();

    await l2BlockRangeRequestHandler.cb({
      requestId: "c",
      requestedAt: Date.now(),
      reason: "manual",
      ranges: [{ from: 19, to: 22, statusHint: "proposed" }],
    });

    const hints = vi
      .mocked(onCatchupBlock)
      .mock.calls.map(([block, statusHint]) => [
        (block as unknown as { height: number }).height,
        statusHint,
      ]);
    expect(hints).toEqual([
      [19, "proven"],
      [20, "proven"],
      [21, "proposed"],
      [22, "proposed"],
    ]);
    // The proven label is only meaningful if the same node served the block.
    expect(networkClient.getLatestProvenHeight).toHaveBeenCalledWith(pinnedNode);
    expect(
      vi.mocked(networkClient.getBlock).mock.calls.map(([, node]) => node),
    ).toEqual([pinnedNode, pinnedNode, pinnedNode, pinnedNode]);
  });
});
