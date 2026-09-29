import { randomUUID } from "node:crypto";
import { type L1GovernanceUriRequestEvent } from "@chicmoz-pkg/message-registry";
import {
  L1_GOVERNANCE_URI_RECONCILIATION_INTERVAL_MS,
  L1_GOVERNANCE_URI_RECONCILIATION_LOOKBACK_DAYS,
  L1_GOVERNANCE_URI_RECONCILIATION_MAX_PROPOSALS,
} from "../../environment.js";
import { l1GovernanceUriRequest } from "../../events/emitted/index.js";
import { logger } from "../../logger.js";
import { queries } from "../database/controllers/l1/governance/index.js";

let interval: NodeJS.Timeout | undefined;
let currentTick: Promise<void> | undefined;
// Set by shutdown: no tick starts, and no interval is armed, afterwards.
let stopped = false;

export const buildGovernanceUriRequest = async (
  reason: L1GovernanceUriRequestEvent["reason"],
): Promise<L1GovernanceUriRequestEvent | null> => {
  const proposals = await queries.getProposalsMissingUri({
    limit: L1_GOVERNANCE_URI_RECONCILIATION_MAX_PROPOSALS,
    lookbackDays: L1_GOVERNANCE_URI_RECONCILIATION_LOOKBACK_DAYS,
  });

  if (proposals.length === 0) {
    logger.info("No governance proposals missing URI found for reconciliation");
    return null;
  }

  return {
    requestId: randomUUID(),
    requestedAt: Date.now(),
    reason,
    proposals: proposals.map((proposal) => ({
      ...proposal,
      l1BlockNumber: proposal.l1BlockNumber.toString() as unknown as bigint,
    })),
    maxProposals: L1_GOVERNANCE_URI_RECONCILIATION_MAX_PROPOSALS,
  };
};

const runTick = async (reason: L1GovernanceUriRequestEvent["reason"]) => {
  const startedAt = Date.now();
  try {
    await l1GovernanceUriRequest(await buildGovernanceUriRequest(reason));
    logger.info(
      `Governance URI reconciliation tick completed in ${Date.now() - startedAt}ms`,
    );
  } catch (error) {
    logger.error(
      `Governance URI reconciliation tick failed: ${(error as Error).message}`,
    );
  }
};

/**
 * Runs one reconciliation tick unless shut down or one is running. The
 * startup request goes through here too, so shutdown waits for it.
 */
export const runGovernanceUriReconciliationOnce = async (
  reason: L1GovernanceUriRequestEvent["reason"] = "cadence",
) => {
  if (stopped) {
    return;
  }
  if (currentTick) {
    logger.info(
      "Skipping governance URI reconciliation tick: previous tick still running",
    );
    return;
  }
  currentTick = runTick(reason);
  try {
    await currentTick;
  } finally {
    currentTick = undefined;
  }
};

export const startGovernanceUriReconciliation = () => {
  if (stopped || interval !== undefined) {
    return;
  }
  logger.info(
    `Starting cadenced governance URI reconciliation every ${L1_GOVERNANCE_URI_RECONCILIATION_INTERVAL_MS}ms`,
  );
  interval = setInterval(() => {
    void runGovernanceUriReconciliationOnce();
  }, L1_GOVERNANCE_URI_RECONCILIATION_INTERVAL_MS);
};

// Resolves once no tick is running, so shutdown can stop ticks before the
// message bus and database they use go away.
export const stopGovernanceUriReconciliation = async () => {
  stopped = true;
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
  await currentTick;
};
