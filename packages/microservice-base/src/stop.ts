import { type Logger } from "@chicmoz-pkg/logger-server";
import { conf } from "./config.js";
import { setSvcState } from "./health.js";
import { MicroserviceBaseSvcState } from "./types.js";

export const stop = async (logger: Logger, reason: string) => {
  logger.warn(`👼 Trying to shutdown gracefully (reason: ${reason})...`);
  // Reverse init order: dependents (message bus consumers, HTTP) stop before
  // what they use (database). Stopping the database first left consumers
  // processing messages against it, each failing and being redelivered.
  for (const svc of [...conf.services].reverse()) {
    setSvcState(svc.svcId, MicroserviceBaseSvcState.SHUTTING_DOWN);
    await svc.shutdown();
  }
  logger.warn("✝ Graceful shutdown complete.");
};
