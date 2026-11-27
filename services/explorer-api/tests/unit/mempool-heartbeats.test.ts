import { describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);

vi.mock("../../src/environment.js", () => ({ L2_NETWORK_ID: "SANDBOX" }));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/svcs/database/controllers/chain-lock.js", () => ({
  withChainLock: (write: (dbTx: unknown) => Promise<void>) => {
    order.push("lock");
    return write({});
  },
}));
vi.mock(
  "../../src/svcs/database/controllers/l2TxEffect/get-tx-effect.js",
  () => ({ txEffectExists: () => Promise.resolve(false) }),
);
vi.mock("../../src/svcs/database/controllers/l2Tx/index.js", () => ({
  deleteTx: vi.fn(),
  storeOrUpdateL2Tx: vi.fn(),
}));
vi.mock("../../src/svcs/database/controllers/dropped-tx/index.js", () => ({
  removeDroppedTxByHash: () => Promise.resolve(0),
}));
vi.mock("../../src/svcs/database/controllers/dropped-tx/store.js", () => ({
  storeDroppedTx: vi.fn(),
}));
vi.mock("../../src/svcs/database/controllers/l2Public-call/delete.js", () => ({
  deletePublicCall: vi.fn(),
}));
vi.mock(
  "../../src/svcs/database/controllers/l2PendingL2ToL1Msg/delete.js",
  () => ({ deleteL2ToL1Msgs: vi.fn() }),
);
// The loop under test starts after parsing; any tx object passes here.
vi.mock("@chicmoz-pkg/types", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chicmozL2PendingTxSchema: {
    safeParse: (data: unknown) => ({ success: true, data }),
  },
}));

const { pendingTxHandler } = await import(
  "../../src/events/received/on-pending-txs.js"
);
const { droppedTxHandler } = await import(
  "../../src/events/received/on-dropped-txs.js"
);

// Each tx's lock wait can be long, so each starts after a heartbeat.
describe("the pending and dropped tx handlers", () => {
  it.each([
    ["pending", pendingTxHandler],
    ["dropped", droppedTxHandler],
  ])(
    "wait for a heartbeat before each %s tx's chain lock, and stop when one fails",
    async (_kind, handler) => {
      order.length = 0;
      const beats: Array<{ pass: () => void; fail: (e: Error) => void }> = [];
      const frame = { txs: [{ txHash: "0x01" }, { txHash: "0x02" }] };

      const handled = handler.cb(
        frame as never,
        () =>
          new Promise<void>((pass, fail) => {
            order.push("beat");
            beats.push({ pass, fail });
          }),
      );
      // Let anything not waiting for the heartbeat run.
      await new Promise((settle) => setTimeout(settle, 20));
      expect(order).toEqual(["beat"]);

      beats[0].pass();
      await vi.waitFor(() => expect(order).toEqual(["beat", "lock", "beat"]));

      beats[1].fail(new Error("rebalancing"));
      await expect(handled).rejects.toThrow("rebalancing");
      expect(order).toEqual(["beat", "lock", "beat"]);
    },
  );
});
