import { type getDb as db } from "@chicmoz-pkg/postgres-helper";
import { type ChicmozL2Block, type HexString } from "@chicmoz-pkg/types";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { L2_NETWORK_ID } from "../../../../environment.js";
import { droppedTx } from "../../schema/dropped-tx/index.js";
import { l2Block, txEffect } from "../../schema/l2block/index.js";
import { getTips } from "../l2/tips.js";
import { getTxEffectOwners } from "./delete.js";
import {
  orphanReplacedBlocks,
  recordBlockTxsAsDropped,
  unOrphanBlock,
} from "./orphan.js";
import { store } from "./store.js";
import { type BlockStoreFacts, type BlockStorePlan } from "./store-plan.js";

type DbExecutor = ReturnType<typeof db>;

/**
 * Serializes block stores across every explorer-api process of the network:
 * taken first in each store transaction and held until it commits.
 */
export const lockBlockStores = async (dbTx: DbExecutor): Promise<void> => {
  await dbTx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`chicmoz:l2-block-store:${L2_NETWORK_ID}`}))`,
  );
};

export const getBlockStoreFacts = async (
  dbTx: DbExecutor,
  block: ChicmozL2Block,
): Promise<BlockStoreFacts> => {
  const [existing] = await dbTx
    .select({ orphanTimestamp: l2Block.orphan_timestamp })
    .from(l2Block)
    .where(eq(l2Block.hash, block.hash))
    .limit(1);
  const sameHeightActive = await dbTx
    .select({ hash: l2Block.hash })
    .from(l2Block)
    .where(
      and(
        eq(l2Block.height, block.height),
        eq(l2Block.version, block.header.globalVariables.version),
        isNull(l2Block.orphan_timestamp),
        ne(l2Block.hash, block.hash),
      ),
    );
  const txOwners = await getTxEffectOwners(
    block.body.txEffects.map((tx) => tx.txHash),
    dbTx,
  );
  const tips = await getTips();
  return {
    existing: existing
      ? { isOrphaned: existing.orphanTimestamp !== null }
      : null,
    sameHeightActive: sameHeightActive.map((row) => row.hash),
    txOwners: txOwners.filter((owner) => owner.blockHash !== block.hash),
    provenTip: tips?.proven.block.number ?? 0,
  };
};

/**
 * Carries out a plan from planBlockStore in the caller's transaction.
 */
export const applyBlockStorePlan = async (
  dbTx: DbExecutor,
  block: ChicmozL2Block,
  plan: Exclude<BlockStorePlan, { action: "skip" }>,
  now: number,
): Promise<void> => {
  const txHashes = block.body.txEffects.map((tx) => tx.txHash);

  if (plan.action !== "keep" && plan.replace) {
    await orphanReplacedBlocks(
      dbTx,
      {
        ...plan.replace,
        rollupVersion: block.header.globalVariables.version,
      },
      now,
    );
  }

  if (plan.action === "unOrphan") {
    await unOrphanBlock(dbTx, block.hash);
  }

  if (plan.action === "insert") {
    // Fee and initiator fields come from the pending tx, whose row is gone
    // once a block included it, so carry them over from the rows deleted
    // below rather than lose them.
    const carriedFeeFields =
      plan.deleteOwners.length > 0
        ? await dbTx
            .select({
              txHash: txEffect.txHash,
              feePayer: txEffect.feePayer,
              feePaymentMethod: txEffect.feePaymentMethod,
              initiator: txEffect.initiator,
            })
            .from(txEffect)
            .where(inArray(txEffect.txHash, txHashes))
        : [];

    // Deleted whole (contracts and all cascade): tx_effect.tx_hash is the
    // table's primary key, so the block's txs cannot be stored while another
    // block holds them. Their other txs are recorded as dropped first.
    const included = new Set<HexString>(txHashes);
    for (const ownerHash of plan.deleteOwners) {
      await recordBlockTxsAsDropped(dbTx, ownerHash, now, included);
      await dbTx.delete(l2Block).where(eq(l2Block.hash, ownerHash));
    }

    await store(block, dbTx);

    for (const fields of carriedFeeFields) {
      if (
        [fields.feePayer, fields.feePaymentMethod, fields.initiator].some(
          (value) => value !== null,
        )
      ) {
        await dbTx
          .update(txEffect)
          .set({
            feePayer: fields.feePayer,
            feePaymentMethod: fields.feePaymentMethod,
            initiator: fields.initiator,
          })
          .where(eq(txEffect.txHash, fields.txHash));
      }
    }
  }

  // A tx the block includes is no longer dropped, pending row or not.
  if (txHashes.length > 0) {
    await dbTx.delete(droppedTx).where(inArray(droppedTx.txHash, txHashes));
  }
};
