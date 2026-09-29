import { L2_BLOCK_RECONCILIATION_INTERVAL_MS } from "../../environment.js";
import { l2BlockRangeRequest } from "../../events/emitted/index.js";
import { logger } from "../../logger.js";
import {
  buildMissingBlockRangeRequest,
  buildTipBoundaryRepairRequest,
} from "../database/controllers/l2block/missing-ranges.js";

let interval: NodeJS.Timeout | undefined;
let currentTick: Promise<void> | undefined;
// Set by shutdown: no tick starts, and no interval is armed, afterwards.
let stopped = false;

const runTick = async (reason: "startup" | "cadence") => {
  const startedAt = Date.now();
  try {
    await l2BlockRangeRequest(await buildMissingBlockRangeRequest({ reason }));
    if (reason === "cadence") {
      await l2BlockRangeRequest(await buildTipBoundaryRepairRequest());
    }
    logger.info(`L2 block reconciliation tick completed in ${Date.now() - startedAt}ms`);
  } catch (error) {
    logger.error(`L2 block reconciliation tick failed: ${(error as Error).message}`);
  }
};

/**
 * Runs one reconciliation tick unless shut down or one is running. The
 * startup request goes through here too, so shutdown waits for it.
 */
export const runL2BlockReconciliationOnce = async (
  reason: "startup" | "cadence" = "cadence",
) => {
  if (stopped) {
    return;
  }
  if (currentTick) {
    logger.info("Skipping L2 block reconciliation tick: previous tick still running");
    return;
  }
  currentTick = runTick(reason);
  try {
    await currentTick;
  } finally {
    currentTick = undefined;
  }
};

export const startL2BlockReconciliation = () => {
  if (stopped || interval !== undefined) {
    return;
  }
  logger.info(
    `Starting cadenced L2 block reconciliation every ${L2_BLOCK_RECONCILIATION_INTERVAL_MS}ms`,
  );
  interval = setInterval(() => {
    void runL2BlockReconciliationOnce();
  }, L2_BLOCK_RECONCILIATION_INTERVAL_MS);
};

// Resolves once no tick is running, so shutdown can stop ticks before the
// message bus and database they use go away.
export const stopL2BlockReconciliation = async () => {
  stopped = true;
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
  await currentTick;
};
