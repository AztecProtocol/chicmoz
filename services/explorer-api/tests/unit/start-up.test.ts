import { describe, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => {
  const order: string[] = [];
  const step = (name: string) => () => {
    order.push(name);
    return Promise.resolve();
  };
  return { order, step };
});

vi.mock("../../src/environment.js", () => ({
  ARCHIVE_MODE: false,
  L1_GOVERNANCE_URI_RECONCILIATION_ENABLED: false,
  L2_BLOCK_RECONCILIATION_ENABLED: false,
  L2_NETWORK_ID: "SANDBOX",
}));
vi.mock("../../src/constants.js", () => ({ AZTEC_SCAN_NOTES: {} }));
vi.mock("../../src/logger.js", () => ({ logger: { info: vi.fn() } }));
vi.mock("../../src/svcs/database/controllers/l2Tx/delete-all-txs.js", () => ({
  deleteAllTxs: vi.fn(),
}));
vi.mock("../../src/svcs/database/controllers/dropped-tx/remove.js", () => ({
  removeMinedDroppedTxs: steps.step("sweep"),
}));
vi.mock(
  "../../src/svcs/database/controllers/l2/chain-info/rollup-version-cache.js",
  () => ({ initializeRollupVersionCache: vi.fn() }),
);
vi.mock("../../src/utils/protocol-contracts.js", () => ({
  initializeProtocolContracts: vi.fn(),
}));
vi.mock("../../src/svcs/database/controllers/l2/aztec-scan-notes.js", () => ({
  updateContractInstanceAztecScanNotes: vi.fn(),
}));
vi.mock("../../src/svcs/cache/chain-revision.js", () => ({
  bumpChainRevision: steps.step("bump"),
}));
vi.mock("../../src/events/received/index.js", () => ({
  subscribeHandlers: steps.step("subscribe"),
}));
vi.mock("../../src/svcs/reconciliation/l2-block-reconciliation.js", () => ({
  runL2BlockReconciliationOnce: vi.fn(),
  startL2BlockReconciliation: vi.fn(),
}));
vi.mock(
  "../../src/svcs/reconciliation/governance-uri-reconciliation.js",
  () => ({
    runGovernanceUriReconciliationOnce: vi.fn(),
    startGovernanceUriReconciliation: vi.fn(),
  }),
);

describe("explorer-api start-up", () => {
  // A crash between a block's commit and its bump leaves cached chain reads
  // from before that commit; the sweep's deletions change them too.
  it("bumps the chain revision after the dropped-tx sweep, before it consumes", async () => {
    const { start } = await import("../../src/start.js");

    await start();

    expect(steps.order).toEqual(["sweep", "bump", "subscribe"]);
  });
});
