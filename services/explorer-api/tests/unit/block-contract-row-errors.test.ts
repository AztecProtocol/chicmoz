import { describe, expect, it, vi } from "vitest";

vi.mock("@chicmoz-pkg/postgres-helper", () => ({ getDb: vi.fn() }));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/utils/resolve-artifact-names.js", () => ({
  buildSelectorMap: vi.fn(),
  selectorMapValueToFunctionName: vi.fn(),
}));

const { storeBlockContracts } = await import(
  "../../src/svcs/database/controllers/l2contract/store.js"
);

type DbTx = Parameters<typeof storeBlockContracts>[0];

const contracts = {
  classes: [{ contractClassId: "0x0a" }, { contractClassId: "0x0b" }],
  instancesDeployed: [],
  instancesUpdated: [],
} as unknown as Parameters<typeof storeBlockContracts>[1];

// pg's error for a failed statement carries its SQLSTATE as `code`.
const pgError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

// The first row's savepoint rejects with `error`; every later one stores.
const failFirstSavepoint = (error: Error) => {
  const transaction = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(true);
  return { transaction, dbTx: { transaction } as unknown as DbTx };
};

describe("a contract row whose savepoint fails", () => {
  it("aborts the block on a lock timeout, so the bus redelivers it", async () => {
    const lockTimeout = pgError(
      "55P03",
      "canceling statement due to lock timeout",
    );
    const { transaction, dbTx } = failFirstSavepoint(lockTimeout);

    await expect(
      storeBlockContracts(dbTx, contracts, () => Promise.resolve()),
    ).rejects.toBe(lockTimeout);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("skips a row that fails on its own data and stores the next", async () => {
    const { transaction, dbTx } = failFirstSavepoint(
      pgError("23505", "duplicate key value violates unique constraint"),
    );

    await storeBlockContracts(dbTx, contracts, () => Promise.resolve());
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
