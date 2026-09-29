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
import { createReconciliationLoop } from "./loop.js";

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

const loop = createReconciliationLoop<L1GovernanceUriRequestEvent["reason"]>({
  name: "governance URI reconciliation",
  intervalMs: L1_GOVERNANCE_URI_RECONCILIATION_INTERVAL_MS,
  cadenceReason: "cadence",
  tick: async (reason) => {
    await l1GovernanceUriRequest(await buildGovernanceUriRequest(reason));
  },
});

/**
 * Runs one reconciliation tick unless shut down or one is running. The
 * startup request goes through here too, so shutdown waits for it.
 */
export const runGovernanceUriReconciliationOnce = loop.runOnce;
export const startGovernanceUriReconciliation = loop.start;
export const stopGovernanceUriReconciliation = loop.stop;
