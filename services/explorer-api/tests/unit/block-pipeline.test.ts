import { type CatchupBlockEvent } from "@chicmoz-pkg/message-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VERSION = 4248422647;

const mocks = vi.hoisted(() => {
  const log: string[] = [];
  const step =
    (name: string) =>
    (..._args: unknown[]) => {
      log.push(name);
      return Promise.resolve();
    };
  return {
    log,
    facts: vi.fn(),
    applyBlockStorePlan: vi.fn(step("apply")),
    lockBlockStores: vi.fn(step("lock")),
    markOpenGapsFulfilledByHeight: vi.fn(step("markGaps")),
    observeRollupVersion: vi.fn(step("observeVersion")),
    storeContracts: vi.fn(step("contracts")),
    removePendingAndDroppedTx: vi.fn(step("pendingTxs")),
    parseBlock: vi.fn(),
  };
});

vi.mock("../../src/environment.js", () => ({ L2_NETWORK_ID: "SANDBOX" }));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@chicmoz-pkg/backend-utils", () => ({
  blockFromBuffer: () => ({}),
  parseBlock: mocks.parseBlock,
}));
vi.mock("@chicmoz-pkg/postgres-helper", () => ({
  getDb: () => ({
    // Stands in for a Postgres transaction: "commit" once the callback
    // resolves, "rollback" if it throws.
    transaction: async (run: (tx: object) => Promise<unknown>) => {
      try {
        const result = await run({});
        mocks.log.push("commit");
        return result;
      } catch (e) {
        mocks.log.push("rollback");
        throw e;
      }
    },
  }),
}));
vi.mock("../../src/svcs/database/controllers/l2block/block-store.js", () => ({
  lockBlockStores: mocks.lockBlockStores,
  getBlockStoreFacts: (...args: unknown[]) => {
    mocks.log.push("facts");
    return mocks.facts(...args) as unknown;
  },
  applyBlockStorePlan: mocks.applyBlockStorePlan,
}));
vi.mock("../../src/svcs/database/index.js", () => ({
  controllers: {
    l2Block: {
      markOpenGapsFulfilledByHeight: mocks.markOpenGapsFulfilledByHeight,
    },
    l2Tx: { removePendingAndDroppedTx: mocks.removePendingAndDroppedTx },
  },
}));
vi.mock(
  "../../src/svcs/database/controllers/l2/chain-info/rollup-version-cache.js",
  () => ({ observeRollupVersion: mocks.observeRollupVersion }),
);
vi.mock("../../src/events/received/on-block/contracts.js", () => ({
  storeContracts: mocks.storeContracts,
}));

const { blockHandler, catchupHandler } = await import(
  "../../src/events/received/on-block/index.js"
);

const HEIGHT = 103_158n;
const parsed = (hash = "0x0394") => ({
  height: HEIGHT,
  hash,
  header: { globalVariables: { version: VERSION } },
  body: { txEffects: [{ txHash: "0x2ba1" }] },
});
const event = (extra: Partial<CatchupBlockEvent> = {}): CatchupBlockEvent => ({
  block: "00",
  blockNumber: Number(HEIGHT),
  statusHint: "proposed",
  ...extra,
});
const facts = (overrides: object = {}) => ({
  existing: null,
  sameHeightActive: [],
  txOwners: [],
  provenTip: 104_539,
  ...overrides,
});
const HOOKS = ["markGaps", "observeVersion", "contracts", "pendingTxs"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.length = 0;
  mocks.parseBlock.mockImplementation(() => Promise.resolve(parsed()));
  mocks.facts.mockResolvedValue(facts());
});

describe("storing a block", () => {
  it("locks, reads, writes and commits in one transaction, then runs the hooks", async () => {
    await blockHandler.cb(event());

    expect(mocks.log).toEqual(["lock", "facts", "apply", "commit", ...HOOKS]);
  });

  it.each([
    [
      "a live proposed block whose tx an active block holds elsewhere",
      () => blockHandler.cb(event()),
      facts({
        txOwners: [
          {
            txHash: "0x2ba1",
            blockHash: "0x2c3d",
            blockHeight: 103_172n,
            rollupVersion: VERSION,
            isOrphaned: false,
          },
        ],
      }),
    ],
    [
      "a live proposed block at a proven height held by another block",
      () => blockHandler.cb(event()),
      facts({ sameHeightActive: ["0xproven-canonical"] }),
    ],
    [
      "a proposed catch-up with an orphaned copy stored",
      () => catchupHandler.cb(event({ catchupReason: "cadence" })),
      facts({ existing: { isOrphaned: true } }),
    ],
    [
      "a proposed reorg_repair block where another block is active",
      () => catchupHandler.cb(event({ catchupReason: "reorg_repair" })),
      facts({ sameHeightActive: ["0xother"] }),
    ],
  ])("skips %s without writing or running hooks", async (_name, run, f) => {
    mocks.facts.mockResolvedValue(f);

    await expect(run()).resolves.toBeUndefined();

    expect(mocks.applyBlockStorePlan).not.toHaveBeenCalled();
    expect(mocks.log).toEqual(["lock", "facts", "commit"]);
  });

  it("lets a proven catch-up displace the stale holder", async () => {
    mocks.facts.mockResolvedValue(
      facts({
        txOwners: [
          {
            txHash: "0x2ba1",
            blockHash: "0x2c3d",
            blockHeight: 103_172n,
            rollupVersion: VERSION,
            isOrphaned: false,
          },
        ],
      }),
    );

    await catchupHandler.cb(event({ statusHint: "proven" }));

    expect(mocks.applyBlockStorePlan.mock.calls[0][2]).toEqual({
      action: "insert",
      replace: null,
      deleteOwners: ["0x2c3d"],
    });
  });

  it("rolls back and rethrows when a write fails, so the bus redelivers", async () => {
    mocks.applyBlockStorePlan.mockRejectedValueOnce(
      new Error("connection reset"),
    );

    await expect(blockHandler.cb(event())).rejects.toThrow("connection reset");

    expect(mocks.log).toEqual(["lock", "facts", "rollback"]);
  });
});

describe("concurrent live and catch-up consumers", () => {
  it("run each block's whole pipeline, hooks included, one at a time", async () => {
    let releaseFirstHook: (() => void) | undefined;
    mocks.storeContracts.mockImplementationOnce(() => {
      mocks.log.push("contracts");
      return new Promise<void>((resolve) => {
        releaseFirstHook = resolve;
      });
    });

    const live = blockHandler.cb(event());
    const catchup = catchupHandler.cb(event({ statusHint: "proven" }));
    await vi.waitFor(() => expect(mocks.log).toContain("contracts"));
    expect(mocks.log.filter((entry) => entry === "lock")).toHaveLength(1);

    releaseFirstHook?.();
    await Promise.all([live, catchup]);

    const once = ["lock", "facts", "apply", "commit", ...HOOKS];
    expect(mocks.log).toEqual([...once, ...once]);
  });
});
