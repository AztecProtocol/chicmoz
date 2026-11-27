import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import {
  ChicmozL2BlockLight,
  HexString,
  chicmozL2BlockLightSchema,
} from "@chicmoz-pkg/types";
import {
  and,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { DB_MAX_BLOCKS, L2_NETWORK_ID } from "../../../../environment.js";
import { l2ReorgBlockTable, l2ReorgTable } from "../../schema/l2/reorg.js";
import { getCurrentRollupVersionNumber } from "../l2/chain-info/rollup-version-cache.js";
import { deriveNativeStatus, getTips } from "../l2/tips.js";
import { getLatestBlockRollupVersion } from "./get-latest.js";
import {
  archive,
  body,
  gasFees,
  globalVariables,
  header,
  l1L2BlockProposedTable,
  l1L2ProofVerifiedTable,
  l1ToL2MessageTree,
  l2Block,
  lastArchive,
  noteHashTree,
  nullifierTree,
  partial,
  publicDataTree,
  state,
  txEffect,
} from "../../../database/schema/l2block/index.js";
import { getBlocksWhereRange, getTableColumnsWithoutId } from "../utils.js";

enum GetTypes {
  BlockHeight,
  BlockHash,
  Range,
}

type GetBlocksByHeight = {
  height: bigint;
  getType: GetTypes.BlockHeight;
};

type GetBlocksByHash = {
  hash: HexString;
  getType: GetTypes.BlockHash;
};

type GetBlocksByRange = {
  from: bigint | undefined;
  to: bigint | undefined;
  getType: GetTypes.Range;
};

/**
 * Options for retrieving blocks
 */
export interface BlockQueryOptions {
  /**
   * Whether to include orphaned blocks
   * @default false
   */
  includeOrphaned?: boolean;
  rollupVersion?: number;
}

/**
 * Resolve the rollup version to filter on for a block lookup.
 *
 * Precedence:
 *   1. Caller-supplied `options.rollupVersion`.
 *   2. The runtime-discovered current rollup version.
 */
const resolveRollupVersion = async (
  options: BlockQueryOptions,
): Promise<number | null> => {
  if (options.rollupVersion !== undefined) {
    return options.rollupVersion;
  }
  return (
    (await getCurrentRollupVersionNumber()) ??
    getLatestBlockRollupVersion(options)
  );
};

export const getBlocks = async (
  {
    from,
    to,
  }: {
    from: bigint | undefined;
    to: bigint | undefined;
  },
  options: BlockQueryOptions = {},
): Promise<ChicmozL2BlockLight[]> => {
  return _getBlocks({ from, to, getType: GetTypes.Range }, options);
};

export const getBlock = async (
  heightOrHash: bigint | HexString,
  options: BlockQueryOptions = {},
): Promise<ChicmozL2BlockLight | null> => {
  const res = await _getBlocks(
    typeof heightOrHash === "bigint"
      ? { height: heightOrHash, getType: GetTypes.BlockHeight }
      : { hash: heightOrHash, getType: GetTypes.BlockHash },
    options,
  );
  if (res.length === 0) {
    return null;
  }
  return res[0];
};

/**
 * Returns representative native-tip boundary blocks.
 */
export const getBlocksByNativeStatus = async (
  options: BlockQueryOptions = {},
): Promise<ChicmozL2BlockLight[]> => {
  const tips = await getTips();
  if (!tips || tips.degradedReason) {
    const latest = await getBlock(-1n, options);
    return latest ? [latest] : [];
  }

  const heights = [
    tips.finalized.block.number,
    tips.proven.block.number,
    tips.checkpointed.block.number,
    tips.proposed.number,
  ];
  const blocks: ChicmozL2BlockLight[] = [];
  const seen = new Set<string>();
  for (const height of heights) {
    const block = await getBlock(BigInt(height), options);
    if (block && !seen.has(block.hash)) {
      seen.add(block.hash);
      blocks.push(block);
    }
  }
  return blocks;
};

type GetBlocksArgs = GetBlocksByHeight | GetBlocksByHash | GetBlocksByRange;

const _getBlocks = async (
  args: GetBlocksArgs,
  options: BlockQueryOptions = {},
): Promise<ChicmozL2BlockLight[]> => {
  const { includeOrphaned = false } = options;
  const whereRange =
    args.getType === GetTypes.Range ? getBlocksWhereRange(args) : undefined;

  if (args.getType === GetTypes.BlockHeight) {
    if (args.height < -1) {
      throw new Error("Invalid height");
    }
  }

  const txEffectsSubquery = db()
    .select({
      bodyId: txEffect.bodyId,
      txHashes:
        sql`json_agg(${txEffect.txHash} ORDER BY ${txEffect.index} ASC)`.as(
          "tx_hashes",
        ),
    })
    .from(txEffect)
    .groupBy(txEffect.bodyId)
    .as("txEffectsAgg");
  const joinQuery = db()
    .select({
      ...getTableColumns(l2Block),
      archive: getTableColumnsWithoutId(archive),
      l1L2BlockProposed: getTableColumnsWithoutId(l1L2BlockProposedTable),
      l1L2ProofVerified: getTableColumnsWithoutId(l1L2ProofVerifiedTable),
      header_LastArchive: getTableColumnsWithoutId(lastArchive),
      header_TotalFees: header.totalFees,
      header_TotalManaUsed: header.totalManaUsed,
      header_SpongeBlobHash: header.spongeBlobHash,
      header_State_L1ToL2MessageTree:
        getTableColumnsWithoutId(l1ToL2MessageTree),
      header_State_Partial_NoteHashTree: getTableColumnsWithoutId(noteHashTree),
      header_State_Partial_NullifierTree:
        getTableColumnsWithoutId(nullifierTree),
      headerState_Partial_PublicDataTree:
        getTableColumnsWithoutId(publicDataTree),
      header_GlobalVariables: getTableColumnsWithoutId(globalVariables),
      header_GlobalVariables_GasFees: getTableColumnsWithoutId(gasFees),
      bodyId: body.id,
      txEffects: txEffectsSubquery.txHashes,
    })
    .from(l2Block)
    .innerJoin(archive, eq(l2Block.hash, archive.fk))
    .innerJoin(header, eq(l2Block.hash, header.blockHash))
    .innerJoin(lastArchive, eq(header.id, lastArchive.fk))
    .innerJoin(state, eq(header.id, state.headerId))
    .innerJoin(l1ToL2MessageTree, eq(state.id, l1ToL2MessageTree.fk))
    .innerJoin(partial, eq(state.id, partial.stateId))
    .innerJoin(noteHashTree, eq(partial.id, noteHashTree.fk))
    .innerJoin(nullifierTree, eq(partial.id, nullifierTree.fk))
    .innerJoin(publicDataTree, eq(partial.id, publicDataTree.fk))
    .innerJoin(globalVariables, eq(header.id, globalVariables.headerId))
    .innerJoin(gasFees, eq(globalVariables.id, gasFees.globalVariablesId))
    .innerJoin(body, eq(l2Block.hash, body.blockHash))
    .leftJoin(
      l1L2BlockProposedTable,
      and(
        eq(l2Block.height, l1L2BlockProposedTable.l2BlockNumber),
        eq(archive.root, l1L2BlockProposedTable.archive),
      ),
    )
    .leftJoin(
      l1L2ProofVerifiedTable,
      and(
        eq(
          l1L2ProofVerifiedTable.l2BlockNumber,
          l1L2BlockProposedTable.l2BlockNumber,
        ),
        eq(
          l1L2ProofVerifiedTable.l1ContractAddress,
          l1L2BlockProposedTable.l1ContractAddress,
        ),
      ),
    )
    .leftJoin(txEffectsSubquery, eq(txEffectsSubquery.bodyId, body.id));

  // Single source of truth for which rollup version this lookup should filter
  // on — falls back to whatever's actually in the DB if the compile-time
  // constant doesn't match (e.g. testnet running an unexpected version).
  const effectiveVersion = await resolveRollupVersion(options);
  const versionFilter =
    effectiveVersion === null
      ? undefined
      : eq(l2Block.version, effectiveVersion);

  let whereQuery;

  switch (args.getType) {
    case GetTypes.BlockHeight:
      if (args.height === -1n) {
        // Get latest block
        whereQuery = joinQuery;
        if (!includeOrphaned) {
          whereQuery = whereQuery.where(
            and(isNull(l2Block.orphan_timestamp), versionFilter),
          );
        } else {
          whereQuery = whereQuery.where(versionFilter);
        }
        whereQuery = whereQuery.orderBy(desc(l2Block.height)).limit(1);
      } else {
        // Get specific height
        whereQuery = joinQuery
          .where(
            and(
              eq(l2Block.height, args.height),
              includeOrphaned ? undefined : isNull(l2Block.orphan_timestamp),
              versionFilter,
            ),
          )
          .limit(1);
      }
      break;
    case GetTypes.BlockHash:
      // When getting by hash, we don't filter orphaned blocks because
      // we might want to retrieve a specific orphaned block
      whereQuery = joinQuery.where(eq(l2Block.hash, args.hash)).limit(1);
      break;
    case GetTypes.Range:
      whereQuery = joinQuery
        .where(
          and(
            includeOrphaned
              ? whereRange
              : and(whereRange, isNull(l2Block.orphan_timestamp)),
            versionFilter,
          ),
        )
        .orderBy(desc(l2Block.height))
        .limit(DB_MAX_BLOCKS);
      break;
  }
  const results = await whereQuery.execute();
  const l2Tips = await getTips();
  const blocks: ChicmozL2BlockLight[] = [];
  for (const result of results) {
    // Use the data from the joined subqueries
    const txEffectsHashes = result.txEffects
      ? (result.txEffects as HexString[]).map((hash) => ({ txHash: hash }))
      : [];

    const blockData = {
      hash: result.hash,
      height: result.height,
      archive: result.archive,
      proposedOnL1: result.l1L2BlockProposed?.l1BlockTimestamp
        ? result.l1L2BlockProposed
        : undefined,
      proofVerifiedOnL1: result.l1L2ProofVerified?.l1BlockTimestamp
        ? result.l1L2ProofVerified
        : undefined,
      // Include orphan information if it exists
      orphan: result.orphan_timestamp
        ? {
            timestamp: result.orphan_timestamp,
            hasOrphanedParent: result.orphan_hasOrphanedParent ?? false,
          }
        : undefined,
      nativeStatus: deriveNativeStatus(
        {
          height: result.height,
          hash: result.hash,
          orphan: result.orphan_timestamp
            ? {
                timestamp: result.orphan_timestamp,
                hasOrphanedParent: result.orphan_hasOrphanedParent ?? false,
              }
            : undefined,
        },
        l2Tips,
      ),
      header: {
        lastArchive: result.header_LastArchive,
        totalFees: result.header_TotalFees,
        totalManaUsed: result.header_TotalManaUsed,
        spongeBlobHash: result.header_SpongeBlobHash,
        state: {
          l1ToL2MessageTree: result.header_State_L1ToL2MessageTree,
          partial: {
            noteHashTree: result.header_State_Partial_NoteHashTree,
            nullifierTree: result.header_State_Partial_NullifierTree,
            publicDataTree: result.headerState_Partial_PublicDataTree,
          },
        },
        globalVariables: {
          ...result.header_GlobalVariables,
          gasFees: result.header_GlobalVariables_GasFees,
        },
      },
      body: {
        txEffects: txEffectsHashes,
      },
    };

    blocks.push(await chicmozL2BlockLightSchema.parseAsync(blockData));
  }
  return blocks;
};

/**
 * Get all orphaned blocks
 * @param limit Maximum number of orphaned blocks to return
 * @returns Array of orphaned blocks
 */
export const getOrphanedBlocks = async (
  limit: number = DB_MAX_BLOCKS,
): Promise<ChicmozL2BlockLight[]> => {
  // Find all orphaned blocks
  const orphanedBlockHashes = await db()
    .select({ hash: l2Block.hash })
    .from(l2Block)
    .where(isNotNull(l2Block.orphan_timestamp))
    .orderBy(desc(l2Block.orphan_timestamp), desc(l2Block.height))
    .limit(limit)
    .execute();

  const blocks: ChicmozL2BlockLight[] = [];

  // Get full block data for each orphaned block
  for (const { hash } of orphanedBlockHashes) {
    const block = await getBlock(hash, { includeOrphaned: true });
    if (block) {
      blocks.push(block);
    }
  }

  return blocks;
};

type Reorg = {
  orphanedBlockHash: HexString;
  height: bigint;
  timestamp: Date;
  nbrOfOrphanedBlocks: number;
};

/**
 * Active reorg records, newest first, each shown by its listed blocks still
 * off the chain (a block no longer stored counts as off). A block counts
 * only for the newest record that lists it, so a block that died again
 * shows once.
 */
export const getReorgs = async (): Promise<Reorg[]> => {
  const rows = await db()
    .select({
      id: l2ReorgTable.id,
      observedAt: l2ReorgTable.observedAt,
      hash: l2ReorgBlockTable.hash,
      height: l2ReorgBlockTable.height,
    })
    .from(l2ReorgTable)
    .innerJoin(
      l2ReorgBlockTable,
      eq(l2ReorgBlockTable.reorgId, l2ReorgTable.id),
    )
    .leftJoin(l2Block, eq(l2Block.hash, l2ReorgBlockTable.hash))
    .where(
      and(
        eq(l2ReorgTable.l2NetworkId, L2_NETWORK_ID),
        isNull(l2ReorgTable.revivedAt),
        or(isNull(l2Block.hash), isNotNull(l2Block.orphan_timestamp)),
        sql`NOT EXISTS (SELECT 1 FROM ${l2ReorgBlockTable} AS newer WHERE newer."hash" = ${l2ReorgBlockTable.hash} AND newer."reorg_id" > ${l2ReorgTable.id})`,
      ),
    )
    .orderBy(desc(l2ReorgTable.observedAt), desc(l2ReorgTable.id));

  const reorgs = new Map<number, Reorg>();
  for (const row of rows) {
    const reorg = reorgs.get(row.id);
    if (!reorg) {
      reorgs.set(row.id, {
        orphanedBlockHash: row.hash,
        height: row.height,
        timestamp: row.observedAt,
        nbrOfOrphanedBlocks: 1,
      });
      continue;
    }
    reorg.nbrOfOrphanedBlocks++;
    if (
      row.height < reorg.height ||
      (row.height === reorg.height && row.hash < reorg.orphanedBlockHash)
    ) {
      reorg.orphanedBlockHash = row.hash;
      reorg.height = row.height;
    }
  }
  return [...reorgs.values()];
};
