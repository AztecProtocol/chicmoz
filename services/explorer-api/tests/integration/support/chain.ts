import { type HexString } from "@chicmoz-pkg/types";
import { type BuiltBlock } from "./blocks.js";

export type Head = { height: bigint; hash: HexString };

export const heads = (blocks: BuiltBlock[]): Head[] =>
  blocks.map(({ height, hash }) => ({ height, hash }));

export type BlockState =
  | "canonical"
  | "absent"
  | { hasOrphanedParent: boolean };

export type ReorgRecord = { active: boolean; blocks: HexString[] };

export type ListedReorg = {
  orphanedBlockHash: HexString;
  height: bigint;
  nbrOfOrphanedBlocks: number;
};

/**
 * Chain state read straight from the database: route reads are cached, and
 * the block reads skip blocks without a body. Call after
 * startExplorerApiForTest, like any explorer-api import.
 */
export const loadChainReads = async () => {
  const { getDb } = await import("@chicmoz-pkg/postgres-helper");
  const { and, asc, eq, isNull } = await import("drizzle-orm");
  const { body, l2Block, txEffect } = await import(
    "../../../src/svcs/database/schema/l2block/index.js"
  );
  const { droppedTx } = await import(
    "../../../src/svcs/database/schema/dropped-tx/index.js"
  );
  const { l2ReorgBlockTable, l2ReorgTable } = await import(
    "../../../src/svcs/database/schema/l2/reorg.js"
  );
  const { l2OpenGapTable } = await import(
    "../../../src/svcs/database/schema/l2/open-gap.js"
  );
  const {
    l2ContractClassRegistered,
    l2ContractInstanceDeployed,
    l2ContractInstanceUpdate,
  } = await import("../../../src/svcs/database/schema/l2contract/index.js");
  const { getReorgs } = await import(
    "../../../src/svcs/database/controllers/l2block/get-block.js"
  );
  const db = getDb();

  /** The canonical blocks of a rollup version, lowest first. */
  const chainOf = (version: number): Promise<Head[]> =>
    db
      .select({ height: l2Block.height, hash: l2Block.hash })
      .from(l2Block)
      .where(
        and(eq(l2Block.version, version), isNull(l2Block.orphan_timestamp)),
      )
      .orderBy(asc(l2Block.height));

  const stateOf = async (hash: HexString): Promise<BlockState> => {
    const [row] = await db
      .select({
        orphanTimestamp: l2Block.orphan_timestamp,
        hasOrphanedParent: l2Block.orphan_hasOrphanedParent,
      })
      .from(l2Block)
      .where(eq(l2Block.hash, hash));
    if (!row) {
      return "absent";
    }
    return row.orphanTimestamp === null
      ? "canonical"
      : { hasOrphanedParent: row.hasOrphanedParent ?? false };
  };

  /** The block whose body holds the tx effect. */
  const ownerOf = async (txHash: HexString): Promise<HexString | undefined> => {
    const [row] = await db
      .select({ blockHash: body.blockHash })
      .from(txEffect)
      .innerJoin(body, eq(txEffect.bodyId, body.id))
      .where(eq(txEffect.txHash, txHash));
    return row?.blockHash;
  };

  /** The contract classes stored with a block. */
  const classesOf = async (blockHash: HexString) =>
    (
      await db
        .select({ id: l2ContractClassRegistered.contractClassId })
        .from(l2ContractClassRegistered)
        .where(eq(l2ContractClassRegistered.blockHash, blockHash))
    ).map(({ id }) => id);

  /** The addresses of the contract instances deployed with a block. */
  const instancesOf = async (blockHash: HexString) =>
    (
      await db
        .select({ address: l2ContractInstanceDeployed.address })
        .from(l2ContractInstanceDeployed)
        .where(eq(l2ContractInstanceDeployed.blockHash, blockHash))
    ).map(({ address }) => address);

  const updateOf = async (address: string) => {
    const [row] = await db
      .select({
        blockHash: l2ContractInstanceUpdate.blockHash,
        timestampOfChange: l2ContractInstanceUpdate.timestampOfChange,
      })
      .from(l2ContractInstanceUpdate)
      .where(eq(l2ContractInstanceUpdate.address, address));
    return row;
  };

  const isDropped = async (txHash: HexString) =>
    (
      await db
        .select({ txHash: droppedTx.txHash })
        .from(droppedTx)
        .where(eq(droppedTx.txHash, txHash))
    ).length > 0;

  /** The reorg records of a rollup version, oldest first, blocks by height. */
  const recordsOf = async (version: number): Promise<ReorgRecord[]> => {
    const rows = await db
      .select({
        id: l2ReorgTable.id,
        revivedAt: l2ReorgTable.revivedAt,
        hash: l2ReorgBlockTable.hash,
      })
      .from(l2ReorgTable)
      .innerJoin(
        l2ReorgBlockTable,
        eq(l2ReorgBlockTable.reorgId, l2ReorgTable.id),
      )
      .where(eq(l2ReorgTable.rollupVersion, version))
      .orderBy(
        asc(l2ReorgTable.id),
        asc(l2ReorgBlockTable.height),
        asc(l2ReorgBlockTable.hash),
      );
    const records = new Map<number, ReorgRecord>();
    for (const row of rows) {
      const record = records.get(row.id) ?? {
        active: row.revivedAt === null,
        blocks: [],
      };
      record.blocks.push(row.hash);
      records.set(row.id, record);
    }
    return [...records.values()];
  };

  /** The block that wrote each reorg record of a rollup version, oldest first. */
  const causesOf = (version: number) =>
    db
      .select({ hash: l2ReorgTable.causeHash, kind: l2ReorgTable.causeKind })
      .from(l2ReorgTable)
      .where(eq(l2ReorgTable.rollupVersion, version))
      .orderBy(asc(l2ReorgTable.id));

  /** The `/l2/reorgs` entries that show one of `blocks`. */
  const listed = async (blocks: BuiltBlock[]): Promise<ListedReorg[]> =>
    (await getReorgs())
      .filter((r) => blocks.some((b) => b.hash === r.orphanedBlockHash))
      .map(({ orphanedBlockHash, height, nbrOfOrphanedBlocks }) => ({
        orphanedBlockHash,
        height,
        nbrOfOrphanedBlocks,
      }));

  const repairOpen = async (height: number) =>
    (
      await db
        .select({ id: l2OpenGapTable.id })
        .from(l2OpenGapTable)
        .where(
          and(
            eq(l2OpenGapTable.reason, "reorg_repair"),
            eq(l2OpenGapTable.fromHeight, height),
            eq(l2OpenGapTable.toHeight, height),
            eq(l2OpenGapTable.status, "open"),
          ),
        )
    ).length > 0;

  return {
    chainOf,
    stateOf,
    ownerOf,
    classesOf,
    instancesOf,
    updateOf,
    isDropped,
    recordsOf,
    listed,
    repairOpen,
    causesOf,
  };
};
