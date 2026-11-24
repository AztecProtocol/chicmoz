import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TX_POLL_INTERVAL_MS } from "../../src/environment.js";
import {
  mockLogger,
  mockNetworkClient,
  resetAllMocks,
} from "../mocks/index.js";

vi.mock("../../src/logger.js", () => ({
  logger: mockLogger,
}));

vi.mock("../../src/svcs/poller/network-client/index.js", () => ({
  getPendingTxs: mockNetworkClient.getPendingTxs,
}));

vi.mock("../../src/events/emitted/on-pending-txs.js", () => ({
  onPendingTxs: vi.fn(),
}));

import {
  startPolling,
  stopPolling,
} from "../../src/svcs/poller/pollers/txs_poller.js";

type SlowPoll = PromiseWithResolvers<never[]>;

describe("pending tx poller", () => {
  beforeEach(() => {
    resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopPolling();
    vi.useRealTimers();
  });

  it.each([
    ["resolves", (poll: SlowPoll) => poll.resolve([])],
    ["rejects", (poll: SlowPoll) => poll.reject(new Error("node unavailable"))],
  ])(
    "runs one poll at a time and polls again once the slow poll %s",
    async (_, settle) => {
      const slowPoll: SlowPoll = Promise.withResolvers();
      mockNetworkClient.getPendingTxs
        .mockReturnValueOnce(slowPoll.promise)
        .mockResolvedValue([]);
      startPolling();

      await vi.advanceTimersByTimeAsync(10 * TX_POLL_INTERVAL_MS);
      expect(mockNetworkClient.getPendingTxs).toHaveBeenCalledTimes(1);

      settle(slowPoll);
      await vi.advanceTimersByTimeAsync(TX_POLL_INTERVAL_MS);
      expect(mockNetworkClient.getPendingTxs).toHaveBeenCalledTimes(2);
    },
  );
});
