import { L2_BLOCK_RECONCILIATION_INTERVAL_MS } from "../../environment.js";
import { l2BlockRangeRequest } from "../../events/emitted/index.js";
import {
  buildMissingBlockRangeRequest,
  buildTipBoundaryRepairRequest,
} from "../database/controllers/l2block/missing-ranges.js";
import { createReconciliationLoop } from "./loop.js";

// Assumes a single explorer-api per network (every manifest runs
// replicas: 1): ticks are serialized in this process only, and gap backoff
// is read and written without cross-process coordination. A second replica
// would send overlapping requests; the resulting duplicate blocks are stored
// idempotently, but the backfill would do double work.
const loop = createReconciliationLoop<"startup" | "cadence">({
  name: "L2 block reconciliation",
  intervalMs: L2_BLOCK_RECONCILIATION_INTERVAL_MS,
  cadenceReason: "cadence",
  tick: async (reason) => {
    await l2BlockRangeRequest(await buildMissingBlockRangeRequest({ reason }));
    if (reason === "cadence") {
      await l2BlockRangeRequest(await buildTipBoundaryRepairRequest());
    }
  },
});

/**
 * Runs one reconciliation tick unless shut down or one is running. The
 * startup request goes through here too, so shutdown waits for it.
 */
export const runL2BlockReconciliationOnce = loop.runOnce;
export const startL2BlockReconciliation = loop.start;
export const stopL2BlockReconciliation = loop.stop;
