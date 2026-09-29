import { type MicroserviceBaseSvc } from "@chicmoz-pkg/microservice-base";
import { stopGovernanceUriReconciliation } from "./governance-uri-reconciliation.js";
import { stopL2BlockReconciliation } from "./l2-block-reconciliation.js";

// The reconciliation timers start in start.ts, after every service is up.
// Listed last among the services, they are stopped first on shutdown (services
// stop in reverse order), so no tick publishes a request or marks gaps while
// the message bus or database is going down.
export const reconciliationService: MicroserviceBaseSvc = {
  svcId: "RECONCILIATION",
  init: () => Promise.resolve(),
  getConfigStr: () => "RECONCILIATION\n(timers start after all services)",
  health: () => true,
  shutdown: async () => {
    await Promise.all([
      stopL2BlockReconciliation(),
      stopGovernanceUriReconciliation(),
    ]);
  },
};
