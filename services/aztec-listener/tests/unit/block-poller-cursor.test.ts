import { type L2Block } from "@aztec-labs/stdlib/block";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProvenSideWorkDeps,
  runProvenSideWork,
} from "../../src/svcs/poller/pollers/block_poller/proven-side-work.js";

type StoredTx = { txHash: string; feePayer: string; txState: string };

const db = vi.hoisted(() => ({
  txs: new Map<string, StoredTx>(),
  published: [] as Record<string, unknown>[],
}));
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({ logger }));
vi.mock("../../src/svcs/database/index.js", () => ({
  txsController: {
    getTxsByHashes: (hashes: string[]) =>
      Promise.resolve(
        hashes.flatMap((hash) => {
          const tx = db.txs.get(hash);
          return tx === undefined ? [] : [{ ...tx }];
        }),
      ),
    storeOrUpdateState: (hash: string, txState: string) => {
      const tx = db.txs.get(hash);
      if (tx !== undefined) {
        tx.txState = txState;
      }
      return Promise.resolve();
    },
  },
}));
vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: (_: string, payload: Record<string, unknown>) => {
    db.published.push(payload);
    return Promise.resolve();
  },
}));

const PAYER = `0x${"11".repeat(32)}`;

// The side work reads a block's number, tx hashes, hash and fee recipient.
const blockAt = (n: number, txHashes: string[] = []) =>
  ({
    number: n,
    body: {
      txEffects: txHashes.map((hash) => ({ txHash: { toString: () => hash } })),
    },
    header: {
      globalVariables: {
        blockNumber: n,
        feeRecipient: { toString: () => "0xfee" },
      },
    },
    hash: () => Promise.resolve(`block-${n}`),
  }) as unknown as L2Block;

/** A pinned node serving `blocks`, whose balance reads fail at the heights in `failing` once each. */
const sourceOf = (blocks: L2Block[], failing = new Set<number>()) => {
  const ranges: { from: number; limit: number }[] = [];
  const source = {
    getBlocks: ({ from, limit }: { from: number; limit: number }) => {
      ranges.push({ from, limit });
      return Promise.resolve(blocks.slice(from - 1, from - 1 + limit));
    },
    // The fee juice balance at a block is its height.
    pinnedRead: (_: string, [block]: unknown[]) => {
      const height = Number(String(block).slice("block-".length));
      return failing.delete(height)
        ? Promise.reject(new Error("storage read failed"))
        : Promise.resolve({ toBigInt: () => BigInt(height) });
    },
  } as unknown as ProvenSideWorkDeps["source"];
  return { source, ranges };
};

const cursorAt = (start: number) => {
  const cursor = { value: start };
  return {
    cursor,
    readCursor: () => Promise.resolve(cursor.value),
    storeCursor: (height: number) => {
      cursor.value = height;
      return Promise.resolve();
    },
  };
};

const balances = () =>
  db.published.map(
    ({ contractAddress, balance, sourceTxHash, blockNumber }) => ({
      contractAddress,
      balance,
      sourceTxHash,
      blockNumber,
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.txs.clear();
  db.published.length = 0;
});

describe("proven side work", () => {
  it("runs a 201-block proven advance over two passes, moving the cursor past each block", async () => {
    const { source, ranges } = sourceOf(
      Array.from({ length: 201 }, (_, i) => blockAt(i + 1)),
    );
    const { cursor, ...cursors } = cursorAt(0);
    const run = () => runProvenSideWork({ source, provenTip: 201, ...cursors });

    await run();
    expect(cursor.value).toBe(200);
    await run();
    expect(cursor.value).toBe(201);

    expect(ranges.every(({ limit }) => limit <= 10)).toBe(true);
    expect(ranges.at(-1)).toEqual({ from: 201, limit: 1 });
  });

  it("stops at a block that fails and runs it again on the next pass", async () => {
    db.txs.set("tx-2", {
      txHash: "tx-2",
      feePayer: PAYER,
      txState: "proposed",
    });
    const { source } = sourceOf(
      [blockAt(1), blockAt(2, ["tx-2"]), blockAt(3)],
      new Set([2]),
    );
    const { cursor, ...cursors } = cursorAt(0);
    const run = () => runProvenSideWork({ source, provenTip: 3, ...cursors });

    await run();
    expect(cursor.value).toBe(1);
    expect(db.published).toEqual([]);
    expect(db.txs.get("tx-2")?.txState).toBe("proposed");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await run();
    expect(cursor.value).toBe(3);
    expect(balances()).toEqual([
      {
        contractAddress: PAYER,
        balance: "2",
        sourceTxHash: "tx-2",
        blockNumber: "2",
      },
    ]);
    expect(db.txs.get("tx-2")?.txState).toBe("proven");
  });

  it("moves its cursor down to a lower proven tip, where a new rollup version's heights start over", async () => {
    const { source } = sourceOf([blockAt(1), blockAt(2), blockAt(3)]);
    const { cursor, ...cursors } = cursorAt(50);

    await runProvenSideWork({ source, provenTip: 2, ...cursors });
    expect(cursor.value).toBe(2);
    await runProvenSideWork({ source, provenTip: 3, ...cursors });
    expect(cursor.value).toBe(3);
  });

  it("sends the same updates when its cursor moves back over a block whose txs it marked proven", async () => {
    db.txs.set("tx-1", { txHash: "tx-1", feePayer: PAYER, txState: "pending" });
    const { source } = sourceOf([blockAt(1, ["tx-1"]), blockAt(2)]);
    const { cursor, ...cursors } = cursorAt(0);
    const run = () => runProvenSideWork({ source, provenTip: 2, ...cursors });

    await run();
    const first = balances();
    expect(db.txs.get("tx-1")?.txState).toBe("proven");
    // As a stored prune or a proof that moved back leaves it.
    cursor.value = 0;
    db.published.length = 0;
    await run();

    expect(balances()).toEqual(first);
    expect(first).toEqual([
      {
        contractAddress: PAYER,
        balance: "1",
        sourceTxHash: "tx-1",
        blockNumber: "1",
      },
    ]);
    expect(cursor.value).toBe(2);
  });
});
