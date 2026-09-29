import { type HexString } from "@chicmoz-pkg/types";
import { type TxEffectOwner } from "./delete.js";

/**
 * Where a block message came from. The live NEW_BLOCK topic is the ordered
 * log of what the listener saw; catch-up events arrive on a separate topic
 * with no ordering against it, often long after they were fetched.
 */
export type BlockEventSource = {
  live: boolean;
  proven: boolean;
};

export type TxOwner = TxEffectOwner;

/** What the DB holds that an incoming block could collide with. */
export type BlockStoreFacts = {
  // The stored block with the incoming block's hash, if any.
  existing: { isOrphaned: boolean } | null;
  // Other active blocks at the incoming block's height and rollup version.
  sameHeightActive: HexString[];
  // Other blocks already holding the incoming block's txs.
  txOwners: TxOwner[];
  // Highest height the explorer knows to be proven (0 when unknown).
  provenTip: number;
};

export type ReplaceStep = {
  // Active blocks at the incoming block's height, to be orphaned.
  hashes: HexString[];
  // When set, active blocks of the same rollup version above this height are
  // orphaned too: they were built on the replaced block.
  descendantsAbove: bigint | null;
};

export type BlockStorePlan =
  | { action: "skip"; reason: string }
  | { action: "keep" }
  | { action: "unOrphan"; replace: ReplaceStep | null }
  | {
      action: "insert";
      replace: ReplaceStep | null;
      deleteOwners: HexString[];
    };

const skip = (reason: string): BlockStorePlan => ({ action: "skip", reason });

/**
 * Decides, before anything is written, what storing a block may change.
 *
 * - A proven block is final: it may replace the block at its height and
 *   delete any block holding its txs (a tx lives in one canonical block).
 * - Nothing but a proven block replaces a block at a proven height.
 * - Above the proven tip, the live stream may replace the block at its
 *   height; replaying it in order converges on the canonical tip. The active
 *   blocks above it are orphaned with it. A proposed catch-up, which may be
 *   stale, only fills heights with no active block.
 * - Blocks holding the incoming block's txs may be deleted along with a
 *   replacement that orphans them; any other holder, active elsewhere or
 *   orphaned earlier, only by a proven block.
 * - An orphaned copy of the block is reactivated only by a proven block, or
 *   by a live block at an unproven height with no active block.
 *
 * Anything not allowed is skipped whole, so a skip never writes.
 */
export const planBlockStore = (
  block: { height: bigint; rollupVersion: number },
  source: BlockEventSource,
  facts: BlockStoreFacts,
): BlockStorePlan => {
  if (facts.existing && !facts.existing.isOrphaned) {
    return { action: "keep" };
  }

  const provenHeight = block.height <= BigInt(facts.provenTip);
  let replace: ReplaceStep | null = null;
  if (facts.sameHeightActive.length > 0) {
    if (!source.proven && provenHeight) {
      return skip(
        `height ${block.height} is proven, and only a proven block may replace the block there`,
      );
    }
    if (!source.proven && !source.live) {
      return skip(
        `a different block is active at height ${block.height}, and a proposed catch-up block may not replace it`,
      );
    }
    replace = {
      hashes: facts.sameHeightActive,
      descendantsAbove: provenHeight ? null : block.height,
    };
  }

  if (facts.existing) {
    if (
      source.proven ||
      (source.live && !provenHeight && facts.sameHeightActive.length === 0)
    ) {
      return { action: "unOrphan", replace };
    }
    return skip(
      "an orphaned copy of this block exists, and only a proven block, or a live block at an unproven height with no active block, may reactivate it",
    );
  }

  const isReplacedHere = (owner: TxOwner) =>
    replace !== null &&
    !owner.isOrphaned &&
    owner.rollupVersion === block.rollupVersion &&
    (replace.hashes.includes(owner.blockHash) ||
      (replace.descendantsAbove !== null &&
        owner.blockHeight > replace.descendantsAbove));
  const otherOwners = facts.txOwners.filter((owner) => !isReplacedHere(owner));
  if (otherOwners.length > 0 && !source.proven) {
    const summary = otherOwners
      .map(
        (owner) =>
          `${owner.txHash} in ${owner.isOrphaned ? "orphaned" : "active"} block ${owner.blockHeight} (${owner.blockHash})`,
      )
      .join(", ");
    return skip(
      `its txs are held by other blocks, which only a proven block may displace: ${summary}`,
    );
  }

  return {
    action: "insert",
    replace,
    deleteOwners: [...new Set(facts.txOwners.map((owner) => owner.blockHash))],
  };
};
