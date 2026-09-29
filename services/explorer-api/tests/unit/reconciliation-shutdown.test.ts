import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INTERVAL_MS = 120_000;

const mocks = vi.hoisted(() => ({
  buildMissingBlockRangeRequest: vi.fn(),
  buildTipBoundaryRepairRequest: vi.fn(() => Promise.resolve(null)),
  l2BlockRangeRequest: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/environment.js", () => ({
  L2_BLOCK_RECONCILIATION_INTERVAL_MS: INTERVAL_MS,
  L1_GOVERNANCE_URI_RECONCILIATION_INTERVAL_MS: INTERVAL_MS,
}));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/events/emitted/index.js", () => ({
  l2BlockRangeRequest: mocks.l2BlockRangeRequest,
  l1GovernanceUriRequest: () => Promise.resolve(),
}));
vi.mock(
  "../../src/svcs/database/controllers/l2block/missing-ranges.js",
  () => ({
    buildMissingBlockRangeRequest: mocks.buildMissingBlockRangeRequest,
    buildTipBoundaryRepairRequest: mocks.buildTipBoundaryRepairRequest,
  }),
);
vi.mock(
  "../../src/svcs/reconciliation/governance-uri-reconciliation.js",
  () => ({ stopGovernanceUriReconciliation: () => Promise.resolve() }),
);

// Fresh module state (interval, running tick, stopped flag) per test.
const load = async () => {
  vi.resetModules();
  return {
    ...(await import(
      "../../src/svcs/reconciliation/l2-block-reconciliation.js"
    )),
    ...(await import("../../src/svcs/reconciliation/index.js")),
  };
};

const pendingBuild = () => {
  let finish: (() => void) | undefined;
  mocks.buildMissingBlockRangeRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(null);
      }),
  );
  return () => finish?.();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.buildMissingBlockRangeRequest.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconciliation shutdown", () => {
  it("waits for a running tick, then no tick runs again", async () => {
    const { startL2BlockReconciliation, reconciliationService } = await load();
    const finishBuild = pendingBuild();
    startL2BlockReconciliation();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mocks.buildMissingBlockRangeRequest).toHaveBeenCalledOnce();

    let stopped = false;
    const shutdown = reconciliationService.shutdown().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finishBuild();
    await shutdown;
    expect(mocks.l2BlockRangeRequest).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(mocks.buildMissingBlockRangeRequest).toHaveBeenCalledOnce();
  });

  it("waits for the startup request, and arms nothing after it", async () => {
    const {
      runL2BlockReconciliationOnce,
      startL2BlockReconciliation,
      reconciliationService,
    } = await load();
    const finishBuild = pendingBuild();
    const startup = runL2BlockReconciliationOnce("startup");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.buildMissingBlockRangeRequest).toHaveBeenCalledWith({
      reason: "startup",
    });

    let stopped = false;
    const shutdown = reconciliationService.shutdown().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finishBuild();
    await Promise.all([startup, shutdown]);

    // start.ts carries on after its startup request; nothing may run now.
    startL2BlockReconciliation();
    await runL2BlockReconciliationOnce("startup");
    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(mocks.buildMissingBlockRangeRequest).toHaveBeenCalledOnce();
  });

  it("does not run the tip repair on the startup request", async () => {
    const { runL2BlockReconciliationOnce } = await load();

    await runL2BlockReconciliationOnce("startup");

    expect(mocks.buildTipBoundaryRepairRequest).not.toHaveBeenCalled();
  });
});
