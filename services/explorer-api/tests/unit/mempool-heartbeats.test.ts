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

// Each tx takes the chain lock in its own transaction, and may wait for it:
// a heartbeat between them keeps the consumer's partition through a long
// frame.
describe("the pending and dropped tx handlers", () => {
  it.each([
    ["pending", pendingTxHandler],
    ["dropped", droppedTxHandler],
  ])(
    "heartbeat before taking the chain lock for each %s tx",
    async (_kind, handler) => {
      order.length = 0;
      const frame = { txs: [{ txHash: "0x01" }, { txHash: "0x02" }] };

      await handler.cb(frame as never, () => {
        order.push("beat");
        return Promise.resolve();
      });

      expect(order).toEqual(["beat", "lock", "beat", "lock"]);
    },
  );
});
