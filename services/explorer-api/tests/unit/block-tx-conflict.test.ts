import { type NewBlockEvent } from "@chicmoz-pkg/message-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  store: vi.fn<() => Promise<void>>(),
  markOpenGapsFulfilledByHeight: vi.fn(() => Promise.resolve()),
  removePendingAndDroppedTx: vi.fn(() => Promise.resolve()),
  storeContracts: vi.fn(() => Promise.resolve()),
  deleteL2BlockByHash: vi.fn(() => Promise.resolve()),
  deleteL2BlockByHeight: vi.fn(() => Promise.resolve()),
  getTxEffectOwners: vi.fn(),
  unOrphanBlock: vi.fn(() => Promise.resolve()),
  detectReorg: vi.fn(() => Promise.resolve(false)),
  handleReorg: vi.fn(() => Promise.resolve()),
  parseBlock: vi.fn(),
}));

vi.mock("../../src/environment.js", () => ({ L2_NETWORK_ID: "SANDBOX" }));
vi.mock("../../src/logger.js", () => ({ logger: mocks.logger }));
vi.mock("@chicmoz-pkg/backend-utils", () => ({
  blockFromBuffer: () => ({}),
  parseBlock: mocks.parseBlock,
}));
vi.mock("../../src/svcs/database/index.js", () => ({
  controllers: {
    l2Block: {
      store: mocks.store,
      markOpenGapsFulfilledByHeight: mocks.markOpenGapsFulfilledByHeight,
    },
    l2Tx: { removePendingAndDroppedTx: mocks.removePendingAndDroppedTx },
  },
}));
vi.mock("../../src/svcs/database/controllers/l2block/delete.js", () => ({
  deleteL2BlockByHash: mocks.deleteL2BlockByHash,
  deleteL2BlockByHeight: mocks.deleteL2BlockByHeight,
  getTxEffectOwners: mocks.getTxEffectOwners,
}));
vi.mock("../../src/svcs/database/controllers/l2block/orphan.js", () => ({
  unOrphanBlock: mocks.unOrphanBlock,
}));
vi.mock(
  "../../src/svcs/database/controllers/l2/chain-info/rollup-version-cache.js",
  () => ({ observeRollupVersion: () => Promise.resolve() }),
);
vi.mock("../../src/events/received/on-block/contracts.js", () => ({
  storeContracts: mocks.storeContracts,
}));
vi.mock("../../src/events/received/on-block/reorg-handler.js", () => ({
  detectReorg: mocks.detectReorg,
  handleReorg: mocks.handleReorg,
}));

const { blockHandler, catchupHandler } = await import(
  "../../src/events/received/on-block/index.js"
);

// Block 103158 from the 2026-09-29 incident: its tx was held by the active,
// stale-fork block 103172.
const parsed = () => ({
  height: 103158n,
  hash: "0x0394",
  header: { globalVariables: { version: 4248422647 } },
  body: { txEffects: [{ txHash: "0x2ba1" }, { txHash: "0x2ba2" }] },
});
const event: NewBlockEvent = {
  block: "00",
  blockNumber: 103158,
  statusHint: "proposed",
};
const txHashConflict = {
  code: "23505",
  detail: "Key (tx_hash)=(0x2ba1) already exists.",
};
const owner = (overrides: object) => ({
  txHash: "0x2ba1",
  blockHash: "0x2c3d",
  blockHeight: 103172n,
  rollupVersion: 4248422647,
  isOrphaned: false,
  ...overrides,
});
const hooks = () => [
  mocks.markOpenGapsFulfilledByHeight,
  mocks.storeContracts,
  mocks.removePendingAndDroppedTx,
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detectReorg.mockResolvedValue(false);
  mocks.parseBlock.mockImplementation(() => Promise.resolve(parsed()));
  mocks.store
    .mockReset()
    .mockRejectedValueOnce(txHashConflict)
    .mockResolvedValue(undefined);
});

describe("a tx held by an active block", () => {
  it.each([
    ["live", () => blockHandler.cb(event)],
    ["catch-up", () => catchupHandler.cb(event)],
  ])(
    "skips the %s block: acked, nothing stored or deleted, logged",
    async (_name, run) => {
      mocks.getTxEffectOwners.mockResolvedValue([owner({})]);

      await expect(run()).resolves.toBeUndefined();

      // Decided before any write: not even an insert attempt.
      expect(mocks.store).not.toHaveBeenCalled();
      expect(mocks.deleteL2BlockByHash).not.toHaveBeenCalled();
      for (const hook of hooks()) {
        expect(hook).not.toHaveBeenCalled();
      }
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "SKIPPED_BLOCK_TX_CONFLICT height=103158 hash=0x0394 owners=0x2ba1 in active block 103172 (0x2c3d)",
      );
    },
  );

  it("skips without pruning the orphaned holders among them either", async () => {
    mocks.getTxEffectOwners.mockResolvedValue([
      owner({ blockHash: "0xorphan", isOrphaned: true }),
      owner({ txHash: "0x2ba2" }),
    ]);

    await expect(blockHandler.cb(event)).resolves.toBeUndefined();

    expect(mocks.deleteL2BlockByHash).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });
});

describe("a holder that turns active between the check and the insert", () => {
  it("is still skipped, as the conflict's outcome, with no hooks", async () => {
    mocks.getTxEffectOwners
      .mockResolvedValueOnce([])
      .mockResolvedValue([owner({})]);

    await expect(blockHandler.cb(event)).resolves.toBeUndefined();

    expect(mocks.store).toHaveBeenCalledOnce();
    expect(mocks.deleteL2BlockByHash).not.toHaveBeenCalled();
    for (const hook of hooks()) {
      expect(hook).not.toHaveBeenCalled();
    }
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/^SKIPPED_BLOCK_TX_CONFLICT /),
    );
  });
});

describe("a reorg at the block's height", () => {
  beforeEach(() => {
    mocks.detectReorg.mockResolvedValue(true);
  });

  it("lets its own reorg orphan an active holder above it, then prunes it and stores", async () => {
    const holders = [owner({ blockHeight: 103159n })];
    mocks.getTxEffectOwners.mockImplementation(() =>
      Promise.resolve(holders.map((holder) => ({ ...holder }))),
    );
    // handleReorg orphans the block at the height and the ones above it.
    mocks.handleReorg.mockImplementation(() => {
      holders[0] = { ...holders[0], isOrphaned: true };
      return Promise.resolve();
    });

    await blockHandler.cb(event);

    expect(mocks.handleReorg).toHaveBeenCalled();
    expect(mocks.deleteL2BlockByHash).toHaveBeenCalledWith("0x2c3d");
    expect(mocks.store).toHaveBeenCalledTimes(2);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ["below the height", owner({ blockHeight: 103157n })],
    ["on another rollup version", owner({ rollupVersion: 1 })],
  ])(
    "skips before the reorg writes anything when the holder is %s",
    async (_name, holder) => {
      mocks.getTxEffectOwners.mockResolvedValue([holder]);

      await expect(blockHandler.cb(event)).resolves.toBeUndefined();

      expect(mocks.handleReorg).not.toHaveBeenCalled();
      expect(mocks.store).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/^SKIPPED_BLOCK_TX_CONFLICT height=103158 /),
      );
    },
  );
});

describe("the block itself already stored and active (redelivery)", () => {
  it("is not a conflict: the duplicate hash counts as stored and the hooks run", async () => {
    mocks.getTxEffectOwners.mockResolvedValue([
      owner({ blockHash: "0x0394", blockHeight: 103158n }),
    ]);
    mocks.store.mockReset().mockRejectedValue({
      code: "23505",
      detail: "Key (hash)=(0x0394) already exists.",
    });

    await blockHandler.cb(event);

    expect(mocks.unOrphanBlock).toHaveBeenCalledWith("0x0394");
    for (const hook of hooks()) {
      expect(hook).toHaveBeenCalledOnce();
    }
  });
});

describe("a duplicate on a key the handler does not know", () => {
  it("does not count as stored: no hooks, logged", async () => {
    mocks.getTxEffectOwners.mockResolvedValue([]);
    mocks.store.mockReset().mockRejectedValue({
      code: "23505",
      detail: "Key (address)=(0x01) already exists.",
    });

    await expect(blockHandler.cb(event)).resolves.toBeUndefined();

    for (const hook of hooks()) {
      expect(hook).not.toHaveBeenCalled();
    }
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("DB duplicate on an unexpected key"),
    );
  });
});

describe("txs held only by orphaned blocks (multi-block reorg)", () => {
  it("prunes them and stores the rebuilt block", async () => {
    // A reorg at 103157 orphaned 103157-103159; the rebuilt 103158
    // re-includes txs from the old 103158 and 103159.
    mocks.getTxEffectOwners.mockResolvedValue([
      owner({
        blockHash: "0xold-103158",
        blockHeight: 103158n,
        isOrphaned: true,
      }),
      owner({
        txHash: "0x2ba2",
        blockHash: "0xold-103159",
        blockHeight: 103159n,
        isOrphaned: true,
      }),
    ]);

    await blockHandler.cb(event);

    expect(mocks.deleteL2BlockByHash.mock.calls).toEqual([
      ["0xold-103158"],
      ["0xold-103159"],
    ]);
    expect(mocks.store).toHaveBeenCalledTimes(2);
    for (const hook of hooks()) {
      expect(hook).toHaveBeenCalledOnce();
    }
  });
});

describe("store errors that are not duplicates", () => {
  it("are rethrown so the message bus redelivers the block", async () => {
    mocks.store.mockReset().mockRejectedValue(new Error("connection reset"));

    await expect(blockHandler.cb(event)).rejects.toThrow("connection reset");

    expect(mocks.store).toHaveBeenCalledOnce();
    for (const hook of hooks()) {
      expect(hook).not.toHaveBeenCalled();
    }
  });
});
