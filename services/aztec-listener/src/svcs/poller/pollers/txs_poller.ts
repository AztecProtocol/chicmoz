import { TX_POLL_INTERVAL_MS } from "../../../environment.js";
import { onPendingTxs } from "../../../events/emitted/on-pending-txs.js";
import { logger } from "../../../logger.js";
import { getPendingTxs } from "../network-client/index.js";

let pollInterval: NodeJS.Timeout;
let pollInFlight = false;

export const startPolling = () => {
  pollInterval = setInterval(() => {
    // A poll holds the whole pending set until it settles; never run two.
    if (pollInFlight) {
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

const fetchAndPublishPendingTxs = async () => {
  pollInFlight = true;
  try {
    const txs = await getPendingTxs();
    await onPendingTxs(txs);
  } catch (error) {
    logger.warn("Error fetching pending txs", error);
  } finally {
    pollInFlight = false;
  }
};
