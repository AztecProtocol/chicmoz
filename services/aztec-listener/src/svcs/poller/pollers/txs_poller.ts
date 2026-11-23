import { TX_POLL_INTERVAL_MS } from "../../../environment.js";
import { onPendingTxs } from "../../../events/emitted/on-pending-txs.js";
import { logger } from "../../../logger.js";
import { getPendingTxs } from "../network-client/index.js";

let pollInterval: NodeJS.Timeout;
let pollInFlight = false;
let skippedTicks = 0;
let lastPollDurationMs: number | undefined;
let lastPendingTxCount: number | undefined;

export const startPolling = () => {
  pollInterval = setInterval(() => {
    // A poll holds the whole pending set until it settles; never run two.
    if (pollInFlight) {
      skippedTicks++;
      return;
    }
    void fetchAndPublishPendingTxs();
  }, TX_POLL_INTERVAL_MS);
};

export const stopPolling = () => {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
};

/** Last settled poll's duration, last fetched pending-set size; resets skippedTicks. */
export const takePollStats = () => {
  const stats = { lastPollDurationMs, lastPendingTxCount, skippedTicks };
  skippedTicks = 0;
  return stats;
};

const fetchAndPublishPendingTxs = async () => {
  pollInFlight = true;
  const startedAt = Date.now();
  try {
    const txs = await getPendingTxs();
    lastPendingTxCount = txs.length;
    await onPendingTxs(txs);
  } catch (error) {
    logger.warn("Error fetching pending txs", error);
  } finally {
    lastPollDurationMs = Date.now() - startedAt;
    pollInFlight = false;
  }
};
