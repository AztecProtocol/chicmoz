import {
  AZTEC_SCAN_MANUAL_SOURCE_CODE_URLS,
  AZTEC_SCAN_NOTES,
} from "./constants.js";
import {
  L1_GOVERNANCE_URI_RECONCILIATION_ENABLED,
  L2_BLOCK_RECONCILIATION_ENABLED,
  L2_NETWORK_ID,
} from "./environment.js";
import { subscribeHandlers } from "./events/received/index.js";
import { logger } from "./logger.js";
import { removeDroppedThatHaveTxEffects } from "./svcs/database/controllers/dropped-tx/remove.js";
import { updateContractInstanceAztecScanNotes } from "./svcs/database/controllers/l2/aztec-scan-notes.js";
import { initializeRollupVersionCache } from "./svcs/database/controllers/l2/chain-info/rollup-version-cache.js";
import { deleteAllTxs } from "./svcs/database/controllers/l2Tx/delete-all-txs.js";
import { updateContractClassManualSourceCodeUrl } from "./svcs/database/controllers/l2contract/update.js";
import { initializeProtocolContracts } from "./utils/protocol-contracts.js";
import {
  runL2BlockReconciliationOnce,
  startL2BlockReconciliation,
} from "./svcs/reconciliation/l2-block-reconciliation.js";
import {
  runGovernanceUriReconciliationOnce,
  startGovernanceUriReconciliation,
} from "./svcs/reconciliation/governance-uri-reconciliation.js";

export const start = async () => {
  await deleteAllTxs(); // TODO: perhaps a more specific deleteAllTxs should be created, also some logs could be good.
  await removeDroppedThatHaveTxEffects();
  await initializeRollupVersionCache();
  await initializeProtocolContracts();
  const aztecScanNotes = AZTEC_SCAN_NOTES[L2_NETWORK_ID];
  if (aztecScanNotes) {
    for (const [contractInstanceAddress, notes] of Object.entries(
      aztecScanNotes,
    )) {
      logger.info(`Updating with hardcoded aztec scan notes for contract: ${contractInstanceAddress}
ORIGIN: ${notes.origin}`);
      await updateContractInstanceAztecScanNotes({
        contractInstanceAddress,
        aztecScanNotes: notes,
      });
    }
  }
  const aztecScanManualSourceCodeUrls =
    AZTEC_SCAN_MANUAL_SOURCE_CODE_URLS[L2_NETWORK_ID];
  if (aztecScanManualSourceCodeUrls) {
    for (const [contractClassId, sourceCodeUrl] of Object.entries(
      aztecScanManualSourceCodeUrls,
    )) {
      logger.info(`Updating with hardcoded aztec scan manual source code urls for contract: ${contractClassId}
URL: ${sourceCodeUrl}`);
      await updateContractClassManualSourceCodeUrl({
        contractClassId,
        sourceCodeUrl,
      });
    }
  }

  await subscribeHandlers();
  // Through the reconciliation ticks, so a shutdown during startup waits for
  // these requests and no interval is armed after it.
  await runL2BlockReconciliationOnce("startup");
  await runGovernanceUriReconciliationOnce("startup");
  if (L2_BLOCK_RECONCILIATION_ENABLED) {
    startL2BlockReconciliation();
  } else {
    logger.info("Cadenced L2 block reconciliation is disabled");
  }
  if (L1_GOVERNANCE_URI_RECONCILIATION_ENABLED) {
    startGovernanceUriReconciliation();
  } else {
    logger.info("Cadenced governance URI reconciliation is disabled");
  }
};
