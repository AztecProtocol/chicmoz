import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VERSION = 4248422647;
const dialect = new PgDialect();
const render = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

const mocks = vi.hoisted(() => {
  const state = {
    calls: [] as Array<[string, string, unknown?]>,
    rows: {} as Record<string, unknown[]>,
  };
  const tableName = (table: object) =>
    (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
  const rowsQuery = (table: object) => {
    const rows = state.rows[tableName(table)] ?? [];
    return Object.assign(Promise.resolve(rows), {
      limit: () => Promise.resolve(rows),
    });
  };
  const tx = {
    select: () => ({
      from: (table: object) => ({
        where: (condition: unknown) => {
          state.calls.push(["select", tableName(table), condition]);
          return rowsQuery(table);
        },
      }),
    }),
    delete: (table: object) => ({
      where: (condition: unknown) => {
        state.calls.push(["delete", tableName(table), condition]);
        return Promise.resolve();
      },
    }),
    update: (table: object) => ({
      set: (values: unknown) => ({
        where: () => {
          state.calls.push(["update", tableName(table), values]);
          return Promise.resolve();
        },
      }),
    }),
    execute: (query: unknown) => {
      state.calls.push(["execute", "", query]);
      return Promise.resolve();
    },
  };
  return {
    state,
    tx,
    store: vi.fn((_block: unknown, _tx: unknown) => {
      state.calls.push(["store", "l2Block"]);
      return Promise.resolve();
    }),
    orphanReplacedBlocks: vi.fn((_tx: unknown, step: unknown) => {
      state.calls.push(["orphanReplaced", "l2Block", step]);
      return Promise.resolve();
    }),
    unOrphanBlock: vi.fn((_tx: unknown, hash: string) => {
      state.calls.push(["unOrphan", "l2Block", hash]);
      return Promise.resolve();
    }),
    recordBlockTxsAsDropped: vi.fn(
      (_tx: unknown, hash: string, _now: number, keep: Set<string>) => {
        state.calls.push(["recordDropped", hash, [...keep]]);
        return Promise.resolve();
      },
    ),
    getTxEffectOwners: vi.fn(),
    getTips: vi.fn(),
  };
});

vi.mock("../../src/environment.js", () => ({ L2_NETWORK_ID: "MAINNET" }));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/svcs/database/controllers/l2block/store.js", () => ({
  store: mocks.store,
}));
vi.mock("../../src/svcs/database/controllers/l2block/orphan.js", () => ({
  orphanReplacedBlocks: mocks.orphanReplacedBlocks,
  unOrphanBlock: mocks.unOrphanBlock,
  recordBlockTxsAsDropped: mocks.recordBlockTxsAsDropped,
}));
vi.mock("../../src/svcs/database/controllers/l2block/delete.js", () => ({
  getTxEffectOwners: mocks.getTxEffectOwners,
}));
vi.mock("../../src/svcs/database/controllers/l2/tips.js", () => ({
  getTips: mocks.getTips,
}));

const { applyBlockStorePlan, getBlockStoreFacts, lockBlockStores } =
  await import("../../src/svcs/database/controllers/l2block/block-store.js");

type Tx = Parameters<typeof applyBlockStorePlan>[0];
type Block = Parameters<typeof applyBlockStorePlan>[1];
const tx = mocks.tx as unknown as Tx;
const block = {
  hash: "0x0394",
  height: 103_158n,
  header: { globalVariables: { version: VERSION } },
  body: { txEffects: [{ txHash: "0x2ba1" }, { txHash: "0x2ba2" }] },
} as unknown as Block;
const summary = () => mocks.state.calls.map(([op, table]) => `${op}:${table}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.calls = [];
  mocks.state.rows = {};
});

describe("lockBlockStores", () => {
  it("takes a transaction-scoped advisory lock for the network", async () => {
    await lockBlockStores(tx);
    const [[, , query]] = mocks.state.calls;
    const { sql, params } = render(query);
    expect(sql).toBe("select pg_advisory_xact_lock(hashtext($1))");
    expect(params).toEqual(["chicmoz:l2-block-store:MAINNET"]);
  });
});

describe("applyBlockStorePlan", () => {
  it("deletes displaced tx holders whole, keeping the moved txs out of the dropped list", async () => {
    mocks.state.rows.tx_effect = [
      {
        txHash: "0x2ba1",
        feePayer: "0xfee",
        feePaymentMethod: "fee_juice",
        initiator: "0xinit",
      },
    ];

    await applyBlockStorePlan(
      tx,
      block,
      { action: "insert", replace: null, deleteOwners: ["0x2c3d"] },
      1,
    );

    expect(summary()).toEqual([
      // fee fields read before the holder is deleted
      "select:tx_effect",
      "recordDropped:0x2c3d",
      "delete:l2Block",
      "store:l2Block",
      // carried onto the new rows after the insert
      "update:tx_effect",
      // a tx the block includes is never also dropped
      "delete:dropped_tx",
    ]);
    const recorded = mocks.state.calls.find(([op]) => op === "recordDropped");
    expect(recorded?.[2]).toEqual(["0x2ba1", "0x2ba2"]);
    const deleted = mocks.state.calls.find(
      ([op, table]) => op === "delete" && table === "l2Block",
    );
    expect(render(deleted?.[2]).params).toEqual(["0x2c3d"]);
    const carried = mocks.state.calls.find(([op]) => op === "update");
    expect(carried?.[2]).toEqual({
      feePayer: "0xfee",
      feePaymentMethod: "fee_juice",
      initiator: "0xinit",
    });
    expect(mocks.store).toHaveBeenCalledWith(block, tx);
  });

  it("orphans a replaced block before inserting, scoped to the rollup version", async () => {
    await applyBlockStorePlan(
      tx,
      block,
      {
        action: "insert",
        replace: { hashes: ["0xstale"], descendantsAbove: null },
        deleteOwners: [],
      },
      1,
    );

    expect(summary()).toEqual([
      "orphanReplaced:l2Block",
      "store:l2Block",
      "delete:dropped_tx",
    ]);
    expect(mocks.orphanReplacedBlocks.mock.calls[0][1]).toEqual({
      hashes: ["0xstale"],
      descendantsAbove: null,
      rollupVersion: VERSION,
    });
  });

  it("un-orphans without inserting", async () => {
    await applyBlockStorePlan(
      tx,
      block,
      { action: "unOrphan", replace: null },
      1,
    );

    expect(summary()).toEqual(["unOrphan:l2Block", "delete:dropped_tx"]);
  });

  it("clears dropped entries for a block that is already stored", async () => {
    await applyBlockStorePlan(tx, block, { action: "keep" }, 1);

    expect(summary()).toEqual(["delete:dropped_tx"]);
    const [[, , condition]] = mocks.state.calls;
    expect(render(condition).params).toEqual(["0x2ba1", "0x2ba2"]);
  });
});

describe("getBlockStoreFacts", () => {
  it("reports the proven tip and leaves the block itself out of the tx holders", async () => {
    mocks.state.rows.l2Block = [{ orphanTimestamp: 5, hash: "0xstale" }];
    mocks.getTxEffectOwners.mockResolvedValue([
      { blockHash: "0x0394" },
      { blockHash: "0x2c3d" },
    ]);
    mocks.getTips.mockResolvedValue({ proven: { block: { number: 104_539 } } });

    const result = await getBlockStoreFacts(tx, block);

    expect(result.existing).toEqual({ isOrphaned: true });
    expect(result.txOwners).toEqual([{ blockHash: "0x2c3d" }]);
    expect(result.provenTip).toBe(104_539);
    expect(mocks.getTxEffectOwners).toHaveBeenCalledWith(
      ["0x2ba1", "0x2ba2"],
      tx,
    );
  });

  it("treats a missing tips row as no proven height", async () => {
    mocks.getTxEffectOwners.mockResolvedValue([]);
    mocks.getTips.mockResolvedValue(null);

    await expect(getBlockStoreFacts(tx, block)).resolves.toMatchObject({
      existing: null,
      provenTip: 0,
    });
  });
});
