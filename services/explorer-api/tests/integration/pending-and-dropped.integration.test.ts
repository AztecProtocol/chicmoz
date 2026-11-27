import {
  type DroppedTxsEvent,
  type PendingTxsEvent,
} from "@chicmoz-pkg/message-registry";
import {
  type ChicmozL2DroppedTx,
  type HexString,
  type PublicCallRequest,
} from "@chicmoz-pkg/types";
import { deliver, frameBytes, loadFixture } from "@chicmoz/test-harness";
import { BSON } from "bson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuiltBlock,
  buildBlock,
  freshTxHash,
  orderedEvent,
} from "./support/blocks.js";
import { loadChainReads } from "./support/chain.js";
import { loadChainLockProbes } from "./support/chain-lock.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

let lastVersion = 1_000;
const freshVersion = () => ++lastVersion;

const droppedRow = (txHash: HexString): ChicmozL2DroppedTx => ({
  txHash,
  createdAsPendingAt: Date.now(),
  droppedAt: Date.now(),
  dropReason: "dropped",
});

// Whether a tx counts as mined decides every write here, so each one runs on
// the chain lock that canonical changes take.
describe("pending and dropped txs on a real database", () => {
  let api: ExplorerApiForTest;
  let reads: Awaited<ReturnType<typeof loadChainReads>>;
  let probes: Awaited<ReturnType<typeof loadChainLockProbes>>;
  let ordered: (b: BuiltBlock) => Promise<void>;
  let dropped: (txHash: HexString) => Promise<void>;
  let pending: (
    txHash: HexString,
    publicCallRequests?: PublicCallRequest[],
  ) => Promise<void>;
  let takeOffChain: (b: BuiltBlock) => Promise<void>;
  let isPending: (txHash: HexString) => Promise<boolean>;
  let storeDropped: (txHash: HexString) => Promise<void>;
  let sweep: () => Promise<number>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    const { droppedTxHandler } = await import(
      "../../src/events/received/on-dropped-txs.js"
    );
    const { pendingTxHandler } = await import(
      "../../src/events/received/on-pending-txs.js"
    );
    const { removeMinedDroppedTxs } = await import(
      "../../src/svcs/database/controllers/dropped-tx/remove.js"
    );
    const { storeDroppedTx } = await import(
      "../../src/svcs/database/controllers/dropped-tx/store.js"
    );
    const { l2Block } = await import(
      "../../src/svcs/database/schema/l2block/index.js"
    );
    const { l2Tx } = await import(
      "../../src/svcs/database/schema/l2tx/index.js"
    );
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    reads = await loadChainReads();
    probes = await loadChainLockProbes();

    const {
      txs: [recorded],
    } = (
      BSON.deserialize(
        frameBytes(
          loadFixture("local-network", "frame", "pending-txs-event-1"),
        ),
      ) as { data: PendingTxsEvent }
    ).data;
    if (!recorded) {
      throw new Error("the recorded pending-txs frame holds no tx");
    }
    ordered = (b) => deliver(blockHandler, orderedEvent(b));
    dropped = (txHash) =>
      deliver(droppedTxHandler, {
        txs: [droppedRow(txHash)],
      } satisfies DroppedTxsEvent);
    pending = (txHash, publicCallRequests) =>
      deliver(pendingTxHandler, {
        txs: [{ ...recorded, txHash, publicCallRequests }],
      } satisfies PendingTxsEvent);
    takeOffChain = async (b) => {
      await db
        .update(l2Block)
        .set({ orphan_timestamp: Date.now(), orphan_hasOrphanedParent: false })
        .where(eq(l2Block.hash, b.hash));
    };
    isPending = async (txHash) =>
      (
        await db
          .select({ txHash: l2Tx.txHash })
          .from(l2Tx)
          .where(eq(l2Tx.txHash, txHash))
      ).length > 0;
    storeDropped = (txHash) => storeDroppedTx(droppedRow(txHash));
    sweep = removeMinedDroppedTxs;
  });

  afterAll(async () => {
    await api?.close();
  });

  it("serializes a dropped tx's write with the block that includes it on the chain lock, so the tx ends mined", async () => {
    const tx = freshTxHash();
    const block = await buildBlock(1_000n, [tx], { version: freshVersion() });
    const deliveries: Promise<void>[] = [];

    const release = await probes.holdChainLock();
    try {
      deliveries.push(ordered(block));
      await probes.untilLockWaiters(1, "the block");
      deliveries.push(dropped(tx));
      await probes.untilLockWaiters(2, "the dropped-tx handler");
    } finally {
      await release();
      await Promise.all(deliveries);
    }

    expect(await reads.ownerOf(tx)).toBe(block.hash);
    expect(await reads.isDropped(tx)).toBe(false);
  });

  it("counts a tx as mined only while a canonical block holds it: a dropped tx an off-chain block holds is stored, a pending tx a canonical block holds is not", async () => {
    const version = freshVersion();
    const [mined, kept] = [freshTxHash(), freshTxHash()];
    const live = await buildBlock(2_000n, [mined], { version });
    const dead = await buildBlock(2_001n, [kept], { version, parent: live });
    await ordered(live);
    await ordered(dead);
    await takeOffChain(dead);

    await dropped(kept);
    await pending(mined);

    expect(await reads.isDropped(kept)).toBe(true);
    expect(await isPending(mined)).toBe(false);
  });

  it("stores a pending tx whose two public calls share their calldata", async () => {
    const tx = freshTxHash();
    const call: PublicCallRequest = {
      msgSender: `0x${"00".repeat(31)}0a`,
      contractAddress: `0x${"00".repeat(31)}0b`,
      isStaticCall: false,
      calldataHash: `0x${"00".repeat(31)}0c`,
      callType: "revertible",
      functionSelector: "0x0000000d",
    };

    await pending(tx, [call, call]);

    expect(await isPending(tx)).toBe(true);
  });

  it("keeps a genuinely dropped tx through the start-up sweep, and removes the dropped row of a mined one", async () => {
    const version = freshVersion();
    const [mined, kept, lost] = [freshTxHash(), freshTxHash(), freshTxHash()];
    const live = await buildBlock(3_000n, [mined], { version });
    const dead = await buildBlock(3_001n, [kept], { version, parent: live });
    await ordered(live);
    await ordered(dead);
    await takeOffChain(dead);
    for (const tx of [mined, kept, lost]) {
      await storeDropped(tx);
    }

    await sweep();

    expect([
      await reads.isDropped(mined),
      await reads.isDropped(kept),
      await reads.isDropped(lost),
    ]).toEqual([false, true, true]);
  });
});
