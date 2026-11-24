import { logger } from "../../logger.js";
import { takePollStats } from "./pollers/txs_poller.js";

export const PROCESS_REPORT_INTERVAL_MS = 60_000;

let reportInterval: NodeJS.Timeout | undefined;

const toMiB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

const logProcessReport = () => {
  const { rss, heapUsed, heapTotal, external, arrayBuffers } =
    process.memoryUsage();
  const poll = takePollStats();
  logger.info(
    `process report: rssMiB=${toMiB(rss)} heapUsedMiB=${toMiB(heapUsed)} heapTotalMiB=${toMiB(heapTotal)} externalMiB=${toMiB(external)} arrayBuffersMiB=${toMiB(arrayBuffers)} pendingTxPollInFlightMs=${poll.inFlightMs ?? "-"} pendingTxPollLastMs=${poll.lastPollDurationMs ?? "-"} pendingTxPollLastTxs=${poll.lastPendingTxCount ?? "-"} pendingTxPollStoredTxs=${poll.lastStoredTxCount ?? "-"} pendingTxPollSkippedTicks=${poll.skippedTicks}`,
  );
};

export const start = () => {
  if (reportInterval) {
    return;
  }
  reportInterval = setInterval(logProcessReport, PROCESS_REPORT_INTERVAL_MS);
  reportInterval.unref();
};

export const stop = () => {
  if (reportInterval) {
    clearInterval(reportInterval);
    reportInterval = undefined;
  }
};
