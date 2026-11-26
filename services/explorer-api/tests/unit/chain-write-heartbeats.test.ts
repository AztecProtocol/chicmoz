import { type HexString } from "@chicmoz-pkg/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("@chicmoz-pkg/postgres-helper", () => ({ getDb: vi.fn() }));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/utils/resolve-artifact-names.js", () => ({
  buildSelectorMap: vi.fn(),
  selectorMapValueToFunctionName: vi.fn(),
}));

const { removePendingAndDroppedTx } = await import(
  "../../src/svcs/database/controllers/l2Tx/remove-pending-and-dropped.js"
);
const { storeBlockContracts } = await import(
  "../../src/svcs/database/controllers/l2contract/store.js"
);

type DbTx = Parameters<typeof storeBlockContracts>[0];

// A chain change runs these loops inside the chain lock, one statement per
// row: a heartbeat before each keeps the consumer's partition.
describe("the per-row write loops of a chain change", () => {
  it("heartbeats before copying each pending tx's fields onto its tx effect", async () => {
    const order: string[] = [];
    const txHashes: HexString[] = ["0x01", "0x02"];
    let deletes = 0;
    const dbTx = {
      delete: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve(
              deletes++ === 0 ? txHashes.map((txHash) => ({ txHash })) : [],
            ),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => {
            order.push("copy");
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as DbTx;

    await removePendingAndDroppedTx(dbTx, txHashes, () => {
      order.push("beat");
      return Promise.resolve();
    });

    expect(order).toEqual(["beat", "copy", "beat", "copy"]);
  });

  it("heartbeats before each contract row's savepoint, and lets a failed heartbeat abort the block", async () => {
    const order: string[] = [];
    const savepoint = { insert: () => ({ values: () => Promise.resolve() }) };
    const dbTx = {
      transaction: (write: (executor: unknown) => Promise<void>) => {
        order.push("row");
        return write(savepoint);
      },
    } as unknown as DbTx;
    const contracts = {
      classes: [{ contractClassId: "0x0a" }, { contractClassId: "0x0b" }],
      instancesDeployed: [{ address: "0x0c" }],
      instancesUpdated: [],
    } as unknown as Parameters<typeof storeBlockContracts>[1];

    await storeBlockContracts(dbTx, contracts, () => {
      order.push("beat");
      return Promise.resolve();
    });
    expect(order).toEqual(["beat", "row", "beat", "row", "beat", "row"]);

    order.length = 0;
    await expect(
      storeBlockContracts(dbTx, contracts, () =>
        Promise.reject(new Error("rebalancing")),
      ),
    ).rejects.toThrow("rebalancing");
    expect(order).toEqual([]);
  });
});
