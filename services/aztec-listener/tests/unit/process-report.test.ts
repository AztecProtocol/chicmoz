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

import { onPendingTxs } from "../../src/events/emitted/on-pending-txs.js";
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

  it("reports a slow poll's age and skipped ticks, then its stored-row count, until the poller service shuts down", async () => {
    vi.useFakeTimers();
    const slowPoll = Promise.withResolvers<never[]>();
    mockNetworkClient.getPendingTxs.mockReturnValue(slowPoll.promise);
    vi.mocked(onPendingTxs).mockResolvedValue(3);
    const lastReport = () => String(mockLogger.info.mock.lastCall?.[0]);
    startPolling();
    // Offset by half a tick so no poll tick lands on the report's tick.
    await vi.advanceTimersByTimeAsync(TX_POLL_INTERVAL_MS / 2);
    startProcessReport();

    await vi.advanceTimersByTimeAsync(PROCESS_REPORT_INTERVAL_MS);
    // Report at 62 s; 15 ticks since 2 s: the one at 4 s starts the slow poll, 14 are skipped.
    expect(mockLogger.info).toHaveBeenCalledOnce();
    expect(lastReport()).toContain("pendingTxPollInFlightMs=58000");
    expect(lastReport()).toContain("pendingTxPollSkippedTicks=14");

    slowPoll.resolve([]);
    await vi.advanceTimersByTimeAsync(PROCESS_REPORT_INTERVAL_MS);
    expect(mockLogger.info).toHaveBeenCalledTimes(2);
    expect(lastReport()).toContain("pendingTxPollStoredTxs=3");

    await pollerService.shutdown();
    mockLogger.info.mockClear();
    await vi.advanceTimersByTimeAsync(PROCESS_REPORT_INTERVAL_MS);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});
