import { type L2TipsEvent } from "@chicmoz-pkg/message-registry";
import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuiltBlock, buildBlock, freshTxHash } from "./support/blocks.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import { chainInfoEvent } from "./support/fixtures.js";

const OLD = 6;
const CURRENT = Number(chainInfoEvent.chainInfo.rollupVersion);
const DAY = 24 * 60 * 60 * 1000;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const word = (n: number): HexString => `0x${n.toString(16).padStart(64, "0")}`;
const { feeJuicePortalAddress, inboxAddress, rollupAddress } =
  chainInfoEvent.chainInfo.l1ContractAddresses;
const RECIPIENT = word(0xbeef);

const READS = [
  "latest block",
  "block list",
  "blocks search by height",
  "UI blocks table",
  "UI tx effects table",
  "fee juice deposits",
  "fee juice deposits of a recipient",
  "L1 contract events",
] as const;
type Read = { read: () => Promise<string[]>; expected: string[] };

// The database right after an upgrade: the old rollup's chain is ahead of
// the current one at the same heights, and the L1 contracts were redeployed.
describe("reads scoped to the current rollup version on a real database", () => {
  let api: ExplorerApiForTest;
  let reads: Record<(typeof READS)[number], Read>;
  let upsertTips: (event: L2TipsEvent) => Promise<void>;
  let storedTips: () => Promise<{ degradedReason?: string; proposed: { number: number } } | null>;
  let current: BuiltBlock[];
  let old: BuiltBlock[];
  let store: (height: bigint, version: number) => Promise<BuiltBlock>;
  let orphanOf: (
    hash: HexString,
  ) => Promise<{ hasOrphanedParent: boolean } | "active" | "absent">;
  let activeCurrentHashes: () => Promise<HexString[]>;
  let droppedOf: (txHashes: HexString[]) => Promise<HexString[]>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { l2RollupVersionObservationTable } = await import(
      "../../src/svcs/database/schema/l2/rollup-version-observation.js"
    );
    const { chainInfoHandler } = await import(
      "../../src/events/received/on-chain-info.js"
    );
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    const { getBlock, getBlocks } = await import(
      "../../src/svcs/database/controllers/l2block/get-block.js"
    );
    const { getLatestBlock } = await import(
      "../../src/svcs/database/controllers/l2block/get-latest.js"
    );
    const { search } = await import(
      "../../src/svcs/database/controllers/l2/search.js"
    );
    const ui = await import("../../src/svcs/database/controllers/ui/tables.js");
    const deposits = {
      ...(await import(
        "../../src/svcs/database/controllers/l1/fee-juice-portal-deposit/get.js"
      )),
      store: (
        await import(
          "../../src/svcs/database/controllers/l1/fee-juice-portal-deposit/store.js"
        )
      ).store,
    };
    const l1Events = {
      ...(await import(
        "../../src/svcs/database/controllers/l1/generic-contract-event/get.js"
      )),
      store: (
        await import(
          "../../src/svcs/database/controllers/l1/generic-contract-event/store.js"
        )
      ).store,
    };
    const tips = await import("../../src/svcs/database/controllers/l2/tips.js");
    upsertTips = tips.upsertTips;
    storedTips = tips.getTips;

    // Fixed first-seen times decide which version is current, whatever order
    // the blocks below arrive in.
    await getDb()
      .insert(l2RollupVersionObservationTable)
      .values(
        [
          [OLD, 2 * DAY],
          [CURRENT, DAY],
        ].map(([version, ago]) => ({
          l2NetworkId: "SANDBOX" as const,
          rollupVersion: version.toString(),
          firstSeenAt: new Date(Date.now() - ago),
          lastSeenAt: new Date(Date.now() - ago),
          firstSeenSource: "chain-info",
          lastSeenSource: "chain-info",
        })),
      );
    await deliver(chainInfoHandler, chainInfoEvent);
    // A replayed chain info of the old rollup must not replace the current
    // L1 contracts that the deposit and event reads filter on.
    await deliver(chainInfoHandler, {
      chainInfo: {
        ...chainInfoEvent.chainInfo,
        rollupVersion: BigInt(OLD),
        l1ContractAddresses: {
          ...chainInfoEvent.chainInfo.l1ContractAddresses,
          rollupAddress: address(0x61),
          feeJuicePortalAddress: address(0x66),
        },
      },
    });

    store = async (height, version) => {
      const block = await buildBlock(height, [freshTxHash()], { version });
      await deliver(blockHandler, {
        block: block.hex,
        blockNumber: Number(block.height),
        statusHint: "proposed",
      });
      return block;
    };
    // Stored first, so a lookup at height 1 that ignores the version meets it
    // before the current block.
    old = [await store(1n, OLD)];
    current = [await store(1n, CURRENT), await store(2n, CURRENT)];
    const replaced = await store(3n, CURRENT);
    current.push(await store(3n, CURRENT));
    // Old blocks arriving after current ones at the same heights, as a
    // replayed backlog would, are not a reorg of the current chain.
    for (const height of [2n, 3n, 4n, 5n]) {
      old.push(await store(height, OLD));
    }
    expect((await getBlock(replaced.hash))?.orphan).toBeDefined();
    orphanOf = async (hash) => {
      const block = await getBlock(hash);
      if (!block) {
        return "absent";
      }
      return block.orphan
        ? { hasOrphanedParent: block.orphan.hasOrphanedParent }
        : "active";
    };
    activeCurrentHashes = async () =>
      (await getBlocks({ from: undefined, to: undefined })).map((b) => b.hash);
    const { getDroppedTxByHash } = await import(
      "../../src/svcs/database/controllers/dropped-tx/get-tx.js"
    );
    droppedOf = async (txHashes) => {
      const dropped: HexString[] = [];
      for (const txHash of txHashes) {
        if (await getDroppedTxByHash(txHash)) {
          dropped.push(txHash);
        }
      }
      return dropped;
    };

    const deposit = (l1ContractAddress: string, n: number, to = RECIPIENT) => ({
      l1ContractAddress,
      l1BlockNumber: BigInt(n),
      l1BlockHash: word(n),
      l1BlockTimestamp: 1_700_000_000 + n,
      l1TransactionHash: word(0x100 + n),
      l1LogIndex: 0,
      isFinalized: true,
      to,
      amount: 10n ** 18n,
      secretHash: word(0x200 + n),
      key: word(0x300 + n),
      index: BigInt(n),
    });
    await deposits.store(deposit(address(0x66), 1));
    await deposits.store(deposit(feeJuicePortalAddress, 2));
    await deposits.store(deposit(feeJuicePortalAddress, 3, word(0xcafe)));
    const l1Event = (l1ContractAddress: string, n: number) => ({
      eventName: "CheckpointProposed",
      eventArgs: {},
      l1ContractAddress,
      l1BlockNumber: BigInt(n),
      l1BlockHash: word(n),
      l1BlockTimestamp: 1_700_000_000 + n,
      l1TransactionHash: word(0x400 + n),
      l1LogIndex: 0,
      isFinalized: true,
    });
    await l1Events.store(l1Event(address(0x61), 1));
    await l1Events.store(l1Event(rollupAddress, 2));
    await l1Events.store(l1Event(inboxAddress, 3));

    const hashes = (blocks: BuiltBlock[]) => blocks.map((b) => b.hash);
    const txs = (blocks: BuiltBlock[]) => blocks.flatMap((b) => b.txHashes);
    reads = {
      "latest block": {
        read: async () => [(await getLatestBlock())?.hash ?? "none"],
        expected: hashes(current.slice(-1)),
      },
      "block list": {
        read: async () =>
          (await getBlocks({ from: undefined, to: undefined })).map((b) => b.hash),
        expected: hashes(current),
      },
      "blocks search by height": {
        read: async () => (await search(3n)).results.blocks.map((b) => b.hash),
        expected: hashes(current.slice(-1)),
      },
      "UI blocks table": {
        read: async () =>
          (await ui.getBlocksForUiTable({ from: undefined, to: undefined })).map(
            (b) => b.blockHash,
          ),
        expected: hashes(current),
      },
      "UI tx effects table": {
        read: async () =>
          (await ui.getTxEffectForUiTable({ getType: 0 })).map((t) => t.txHash),
        expected: txs(current),
      },
      "fee juice deposits": {
        read: async () =>
          (await deposits.getAll()).map((d) => d.l1TransactionHash ?? "none"),
        expected: [word(0x102), word(0x103)],
      },
      "fee juice deposits of a recipient": {
        read: async () =>
          (await deposits.getByL2Address(RECIPIENT)).map(
            (d) => d.l1TransactionHash ?? "none",
          ),
        expected: [word(0x102)],
      },
      "L1 contract events": {
        read: async () =>
          (await l1Events.get()).map((e) => e.l1TransactionHash ?? "none"),
        expected: [word(0x402), word(0x403)],
      },
    };
  });

  afterAll(async () => {
    await api?.close();
  });

  it.each(READS)("%s: current rows only", async (name) => {
    const { read, expected } = reads[name];
    expect((await read()).sort()).toEqual([...expected].sort());
  });

  it("validates the tips against current-version blocks", async () => {
    const [block1, block2, block3] = current;
    const at = (b: BuiltBlock, n: number) => ({
      block: { number: Number(b.height), hash: b.hash },
      checkpoint: { number: n, hash: word(0x500 + n) },
    });
    await upsertTips({
      tips: {
        proposed: { number: Number(block3.height), hash: block3.hash },
        checkpointed: at(block2, 2),
        proven: at(block1, 1),
        finalized: at(block1, 1),
      },
      observedAt: Date.now(),
      source: { rpcNodeName: "node", aztecNodeVersion: "test" },
    });

    const stored = await storedTips();
    expect(stored?.proposed.number).toBe(Number(block3.height));
    expect(stored?.degradedReason).toBeUndefined();
  });

  // The two reorg cases change the seed, so they run last.
  it("orphans only current-version blocks on a reorg of the current chain", async () => {
    const [, block2, block3] = current;
    const oldAbove = old.filter((b) => b.height > 2n);

    await store(2n, CURRENT);

    expect(await orphanOf(block2.hash)).toEqual({ hasOrphanedParent: false });
    expect(await orphanOf(block3.hash)).toEqual({ hasOrphanedParent: true });
    expect(await Promise.all(oldAbove.map((b) => orphanOf(b.hash)))).toEqual(
      oldAbove.map(() => "active"),
    );
    expect(await droppedOf(oldAbove.flatMap((b) => b.txHashes))).toEqual([]);
  });

  it("orphans only that version's blocks on a reorg of an older chain", async () => {
    const activeCurrent = await activeCurrentHashes();
    const [old1, ...oldAbove] = old;

    await store(1n, OLD);

    expect(await orphanOf(old1.hash)).toEqual({ hasOrphanedParent: false });
    expect(await Promise.all(oldAbove.map((b) => orphanOf(b.hash)))).toEqual(
      oldAbove.map(() => ({ hasOrphanedParent: true })),
    );
    expect(await activeCurrentHashes()).toEqual(activeCurrent);
  });
});
