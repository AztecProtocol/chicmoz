import { TX_POLL_INTERVAL_MS } from "../../../environment.js";
import { onPendingTxs } from "../../../events/emitted/on-pending-txs.js";
import { logger } from "../../../logger.js";
import { getPendingTxs } from "../network-client/index.js";

let pollInterval: NodeJS.Timeout;
let pollInFlight = false;
let pollStartedAt = 0;
let skippedTicks = 0;
let lastPollDurationMs: number | undefined;
let lastPendingTxCount: number | undefined;
let lastStoredTxCount: number | undefined;

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

/** Running poll's age, last settled poll's duration and set sizes; resets skippedTicks. */
export const takePollStats = () => {
  const stats = {
    inFlightMs: pollInFlight ? Date.now() - pollStartedAt : undefined,
    lastPollDurationMs,
    lastPendingTxCount,
    lastStoredTxCount,
    skippedTicks,
  };
  skippedTicks = 0;
  return stats;
};

const fetchAndPublishPendingTxs = async () => {
  pollInFlight = true;
  pollStartedAt = Date.now();
  try {
    const txs = await getPendingTxs();
    lastPendingTxCount = txs.length;
    lastStoredTxCount = (await onPendingTxs(txs)) ?? lastStoredTxCount;
  } catch (error) {
    logger.warn("Error fetching pending txs", error);
  } finally {
    lastPollDurationMs = Date.now() - pollStartedAt;
    pollInFlight = false;
  }
};
