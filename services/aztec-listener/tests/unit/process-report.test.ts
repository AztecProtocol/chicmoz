import { afterEach, describe, expect, it, vi } from "vitest";
import { TX_POLL_INTERVAL_MS } from "../../src/environment.js";
import {
  mockLogger,
  mockMessageBus,
  mockNetworkClient,
} from "../mocks/index.js";

vi.mock("../../src/logger.js", () => ({
  logger: mockLogger,
}));

vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: mockMessageBus.publishMessage,
  publishMessageSync: mockMessageBus.publishMessageSync,
}));

vi.mock("../../src/svcs/poller/network-client/index.js", () => ({
  getPendingTxs: mockNetworkClient.getPendingTxs,
}));

vi.mock("../../src/events/emitted/on-pending-txs.js", () => ({
  onPendingTxs: vi.fn(),
}));

import { pollerService } from "../../src/svcs/poller/index.js";
import { startPolling } from "../../src/svcs/poller/pollers/txs_poller.js";
import {
  PROCESS_REPORT_INTERVAL_MS,
  start as startProcessReport,
} from "../../src/svcs/poller/process-report.js";

describe("process report", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the ticks skipped behind a slow poll until the poller service shuts down", async () => {
    vi.useFakeTimers();
    const slowPoll = Promise.withResolvers<never[]>();
    mockNetworkClient.getPendingTxs.mockReturnValue(slowPoll.promise);
    startPolling();
    // Offset by half a tick so no poll tick lands on the report's tick.
    await vi.advanceTimersByTimeAsync(TX_POLL_INTERVAL_MS / 2);
    startProcessReport();

    await vi.advanceTimersByTimeAsync(PROCESS_REPORT_INTERVAL_MS);
    // 15 ticks in the report's minute: the first starts the slow poll, 14 are skipped.
    expect(mockLogger.info).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("pendingTxPollSkippedTicks=14"),
    );

    await pollerService.shutdown();
    slowPoll.resolve([]);
    mockLogger.info.mockClear();
    await vi.advanceTimersByTimeAsync(PROCESS_REPORT_INTERVAL_MS);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});
