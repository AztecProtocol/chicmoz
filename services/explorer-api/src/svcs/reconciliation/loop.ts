import { logger } from "../../logger.js";

/**
 * The start/stop/tick scaffolding shared by the reconciliation loops: one
 * tick at a time (an interval firing during a tick is skipped), and once
 * stopped no tick starts and no interval is armed. `stop` resolves when no
 * tick is running, so shutdown can stop the loops before the message bus and
 * database they use go away.
 */
export const createReconciliationLoop = <Reason extends string>({
  name,
  intervalMs,
  cadenceReason,
  tick,
}: {
  name: string;
  intervalMs: number;
  cadenceReason: Reason;
  tick: (reason: Reason) => Promise<void>;
}) => {
  let interval: NodeJS.Timeout | undefined;
  let currentTick: Promise<void> | undefined;
  let stopped = false;

  const runOnce = async (reason: Reason = cadenceReason) => {
    if (stopped) {
      return;
    }
    if (currentTick) {
      logger.info(`Skipping ${name} tick: previous tick still running`);
      return;
    }
    const startedAt = Date.now();
    currentTick = tick(reason)
      .then(() => {
        logger.info(`${name} tick completed in ${Date.now() - startedAt}ms`);
      })
      .catch((error: unknown) => {
        logger.error(`${name} tick failed: ${(error as Error).message}`);
      });
    try {
      await currentTick;
    } finally {
      currentTick = undefined;
    }
  };

  const start = () => {
    if (stopped || interval !== undefined) {
      return;
    }
    logger.info(`Starting cadenced ${name} every ${intervalMs}ms`);
    interval = setInterval(() => {
      void runOnce();
    }, intervalMs);
  };

  const stop = async () => {
    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    await currentTick;
  };

  return { runOnce, start, stop };
};
