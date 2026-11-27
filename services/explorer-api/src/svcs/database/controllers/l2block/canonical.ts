import { type Heartbeat } from "@chicmoz-pkg/message-bus";
import { getDb as db } from "@chicmoz-pkg/postgres-helper";
import { type ChicmozL2Block, type HexString } from "@chicmoz-pkg/types";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { L2_NETWORK_ID } from "../../../../environment.js";
import { logger } from "../../../../logger.js";
import { droppedTx } from "../../schema/dropped-tx/index.js";
import { l2ReorgBlockTable, l2ReorgTable } from "../../schema/l2/reorg.js";
import {
  archive,
  body,
  header,
  l2Block,
  lastArchive,
  txEffect,
} from "../../schema/l2block/index.js";
import {
  storeBlockContracts,
  type BlockContracts,
} from "../l2contract/store.js";
import { removePendingAndDroppedTx } from "../l2Tx/remove-pending-and-dropped.js";
import { type DbTx } from "../utils.js";
import { fulfilRepairHeight, recordRepairHeights } from "./missing-ranges.js";
import { store, writeTxEffect } from "./store.js";

// Every change to which blocks are canonical goes through this module.
//
// Invariant: once a listener pass is applied, the canonical blocks of each
// rollup version (orphan_timestamp IS NULL) hold at most one block per
// height, any two at adjacent heights are linked, and none sits above the
// pass's tip. Linked: child.last_archive.root = parent.archive.root, one
// height apart, same version. The child's hash covers its last archive; the
// parent's archive root is outside the parent's hash, so two stored parents
// make a lookup ambiguous.
//
// Ordered blocks are the listener's chain, sent in order: each is canonical
// at its height and nothing canonical stays above its tip. Catch-up blocks
// only fill empty heights below the canonical head; one that the chain above
// descends from carries that chain's authority over the heights below it.

/** Walks stop after this many steps; more canonical blocks than this above a tip is corrupted state. */
export const WALK_BOUND = 10_000;
const HEARTBEAT_EVERY = 500;
const LOCK_NAMESPACE = 1_815_307_112;
const ROWS_PER_STATEMENT = 1_000;

/**
 * Runs `fn` in one transaction that first takes the network's chain lock,
 * which every chain change takes; the dropped- and pending-tx handlers write
 * without it. `lock_timeout` bounds every lock wait in the transaction, this
 * one included: a wait over 10 s throws, so the message is redelivered.
 */
export const withChainLock = <T>(fn: (dbTx: DbTx) => Promise<T>): Promise<T> =>
  db().transaction(async (dbTx) => {
    await dbTx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await dbTx.execute(
      sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int4, hashtext(${L2_NETWORK_ID}))`,
    );
    return fn(dbTx);
  });

export type IncomingBlock = {
  block: ChicmozL2Block;
  contracts: BlockContracts;
};

/** `canonical`: the block ends on the chain, its txs attached from its message. */
export type ChainOutcome = { canonical: boolean };

type ChainBlock = {
  hash: HexString;
  height: bigint;
  version: number;
  canonical: boolean;
  archiveRoot: string | null;
  lastArchiveRoot: string | null;
};

type StoredBlock = ChainBlock & { bodyId: string; created: boolean };

type Change = {
  dbTx: DbTx;
  version: number;
  now: number;
  heartbeat: Heartbeat;
  steps: number;
  demoted: Map<HexString, bigint>;
  promoted: Map<HexString, bigint>;
  // Made canonical without their own message: their moved txs need it back.
  walked: Map<HexString, bigint>;
  repairs: Set<bigint>;
};

type TxOwner = {
  txHash: HexString;
  blockHash: HexString;
  height: bigint;
  canonical: boolean;
};

class TxConflict extends Error {
  constructor(
    readonly block: ChicmozL2Block,
    readonly owners: TxOwner[],
  ) {
    super(`block ${block.height} shares txs with canonical blocks`);
  }
}

/**
 * Runs `write` over `items` in statements of at most ROWS_PER_STATEMENT rows,
 * heartbeating before each: KafkaJS sends at most one heartbeat per interval,
 * so the calls cost nothing in between.
 */
const inStatements = async <T>(
  change: Change,
  items: T[],
  write: (part: T[]) => Promise<void>,
) => {
  for (let i = 0; i < items.length; i += ROWS_PER_STATEMENT) {
    await change.heartbeat();
    await write(items.slice(i, i + ROWS_PER_STATEMENT));
  }
};

const step = async (change: Change) => {
  change.steps++;
  if (change.steps % HEARTBEAT_EVERY === 0) {
    await change.heartbeat();
  }
};

const chainBlocks = (dbTx: DbTx) =>
  dbTx
    .select({
      hash: l2Block.hash,
      height: l2Block.height,
      version: l2Block.version,
      orphanTimestamp: l2Block.orphan_timestamp,
      archiveRoot: archive.root,
      lastArchiveRoot: lastArchive.root,
    })
    .from(l2Block)
    .innerJoin(archive, eq(archive.fk, l2Block.hash))
    .innerJoin(header, eq(header.blockHash, l2Block.hash))
    .innerJoin(lastArchive, eq(lastArchive.fk, header.id));

const toChainBlock = ({
  orphanTimestamp,
  ...row
}: {
  hash: HexString;
  height: bigint;
  version: number;
  orphanTimestamp: number | null;
  archiveRoot: string | null;
  lastArchiveRoot: string | null;
}): ChainBlock => ({ ...row, canonical: orphanTimestamp === null });

const canonicalAt = async (change: Change, height: bigint) =>
  (
    await chainBlocks(change.dbTx).where(
      and(
        eq(l2Block.version, change.version),
        eq(l2Block.height, height),
        isNull(l2Block.orphan_timestamp),
      ),
    )
  ).map(toChainBlock);

const storedParents = async (change: Change, child: ChainBlock) =>
  child.lastArchiveRoot === null
    ? []
    : (
        await chainBlocks(change.dbTx)
          .where(
            and(
              eq(archive.root, child.lastArchiveRoot),
              eq(l2Block.height, child.height - 1n),
              eq(l2Block.version, child.version),
            ),
          )
          .limit(2)
      ).map(toChainBlock);

const canonicalChildren = async (
  change: Change,
  parents: ChainBlock[],
  height: bigint,
) => {
  const roots = parents.flatMap((p) => (p.archiveRoot ? [p.archiveRoot] : []));
  if (roots.length === 0) {
    return [];
  }
  return (
    await chainBlocks(change.dbTx).where(
      and(
        inArray(lastArchive.root, roots),
        eq(l2Block.height, height),
        eq(l2Block.version, change.version),
        isNull(l2Block.orphan_timestamp),
      ),
    )
  ).map(toChainBlock);
};

const txOwners = async (dbTx: DbTx, txHashes: HexString[]) =>
  txHashes.length === 0
    ? []
    : (
        await dbTx
          .select({
            txHash: txEffect.txHash,
            blockHash: l2Block.hash,
            height: l2Block.height,
            orphanTimestamp: l2Block.orphan_timestamp,
          })
          .from(txEffect)
          .innerJoin(body, eq(txEffect.bodyId, body.id))
          .innerJoin(l2Block, eq(body.blockHash, l2Block.hash))
          .where(inArray(txEffect.txHash, txHashes))
      ).map(
        ({ orphanTimestamp, ...owner }): TxOwner => ({
          ...owner,
          canonical: orphanTimestamp === null,
        }),
      );

const ownedTxs = async (change: Change, blockHashes: HexString[]) => {
  const owned: { txHash: HexString; birth: number }[] = [];
  await inStatements(change, blockHashes, async (part) => {
    owned.push(
      ...(await change.dbTx
        .select({ txHash: txEffect.txHash, birth: txEffect.txBirthTimestamp })
        .from(txEffect)
        .innerJoin(body, eq(txEffect.bodyId, body.id))
        .where(inArray(body.blockHash, part))),
    );
  });
  return owned;
};

const demote = async (change: Change, blocks: { hash: HexString }[]) => {
  const hashes = blocks
    .map((b) => b.hash)
    .filter((hash) => !change.demoted.has(hash));
  await inStatements(change, hashes, async (part) => {
    const rows = await change.dbTx
      .update(l2Block)
      .set({ orphan_timestamp: change.now, orphan_hasOrphanedParent: false })
      .where(and(inArray(l2Block.hash, part), isNull(l2Block.orphan_timestamp)))
      .returning({ hash: l2Block.hash, height: l2Block.height });
    rows.forEach((row) => change.demoted.set(row.hash, row.height));
  });
};

const promote = async (
  change: Change,
  block: ChainBlock,
  { walked }: { walked: boolean },
) => {
  const rows = await change.dbTx
    .update(l2Block)
    .set({ orphan_timestamp: null, orphan_hasOrphanedParent: false })
    .where(
      and(eq(l2Block.hash, block.hash), isNotNull(l2Block.orphan_timestamp)),
    )
    .returning({ hash: l2Block.hash });
  if (rows.length > 0) {
    change.promoted.set(block.hash, block.height);
    if (walked) {
      change.walked.set(block.hash, block.height);
    }
  }
};

/** Demotes `start` and the canonical blocks linked above it, up to `ceiling`. */
const demoteLinkedRun = async (
  change: Change,
  start: ChainBlock,
  ceiling: bigint,
) => {
  const run = [start];
  let frontier = [start];
  for (
    let height = start.height + 1n, steps = 0;
    height <= ceiling && frontier.length > 0 && steps < WALK_BOUND;
    height++, steps++
  ) {
    await step(change);
    frontier = await canonicalChildren(change, frontier, height);
    run.push(...frontier);
  }
  await demote(change, run);
};

/**
 * Demotes every other canonical block of the version up to `ceiling` that
 * holds one of `block`'s txs, with its linked run up to `ceiling`: a tx is
 * included once per chain, so no such holder is on the chain `block` is
 * canonical on.
 */
const demoteHolders = async (
  change: Change,
  block: ChicmozL2Block,
  ceiling: bigint,
) => {
  const holders = new Set(
    (
      await txOwners(
        change.dbTx,
        block.body.txEffects.map((e) => e.txHash),
      )
    )
      .filter(
        (o) => o.canonical && o.blockHash !== block.hash && o.height <= ceiling,
      )
      .map((o) => o.blockHash),
  );
  for (const hash of holders) {
    const [holder] = (
      await chainBlocks(change.dbTx).where(
        and(
          eq(l2Block.hash, hash),
          eq(l2Block.version, change.version),
          isNull(l2Block.orphan_timestamp),
        ),
      )
    ).map(toChainBlock);
    if (holder) {
      await demoteLinkedRun(change, holder, ceiling);
    }
  }
};

/**
 * Brings back the stored, off-chain ancestors of a block that just became
 * canonical, demoting their competitors. Ends at a canonical parent; at a
 * missing one, or after WALK_BOUND blocks, it clears that height, whose block
 * cannot be the parent, and asks for the parent.
 */
const reviveAncestors = async (change: Change, start: ChainBlock) => {
  let child = start;
  for (let steps = 0; child.height > 1n; steps++) {
    const below = child.height - 1n;
    await step(change);
    const parents = await storedParents(change, child);
    if (parents.length > 1) {
      logger.error(
        `CHAIN_LINK_CONFLICT: several stored blocks at ${below} have the archive root that block ${child.height} (${child.hash}) names; height ${below} left as it is`,
      );
      return;
    }
    const [parent] = parents;
    if (parent?.canonical) {
      return;
    }
    await demote(change, await canonicalAt(change, below));
    if (!parent || steps === WALK_BOUND) {
      change.repairs.add(below);
      return;
    }
    await promote(change, parent, { walked: true });
    child = parent;
  }
};

/** Asks for every height below `height` that this change left without a canonical block. */
const requestEmptied = async (change: Change, height: bigint) => {
  const emptied = [
    ...new Set([...change.demoted.values()].filter((h) => h < height)),
  ];
  const occupied = new Set<bigint>();
  await inStatements(change, emptied, async (part) => {
    const rows = await change.dbTx
      .selectDistinct({ height: l2Block.height })
      .from(l2Block)
      .where(
        and(
          eq(l2Block.version, change.version),
          inArray(l2Block.height, part),
          isNull(l2Block.orphan_timestamp),
        ),
      );
    rows.forEach((row) => occupied.add(row.height));
  });
  emptied.filter((h) => !occupied.has(h)).forEach((h) => change.repairs.add(h));
};

const demoteAbove = async (change: Change, ceiling: bigint) => {
  const above = await change.dbTx
    .select({ hash: l2Block.hash })
    .from(l2Block)
    .where(
      and(
        eq(l2Block.version, change.version),
        gt(l2Block.height, ceiling),
        isNull(l2Block.orphan_timestamp),
      ),
    )
    .limit(WALK_BOUND + 1);
  if (above.length > WALK_BOUND) {
    throw new Error(
      `More than ${WALK_BOUND} canonical blocks of rollup version ${change.version} above tip ${ceiling}: refusing to demote them`,
    );
  }
  await demote(change, above);
};

// `head`: no canonical block above, so nothing to descend from.
type Link = { walked: ChainBlock[] } | "excludes" | "undecided" | "head";

/**
 * Whether the lowest canonical block above an empty height descends from
 * `block`, through the stored, off-chain blocks between them.
 */
const linkFromAbove = async (
  change: Change,
  block: ChainBlock,
): Promise<Link> => {
  const [lowest] = await chainBlocks(change.dbTx)
    .where(
      and(
        eq(l2Block.version, change.version),
        gt(l2Block.height, block.height),
        isNull(l2Block.orphan_timestamp),
      ),
    )
    .orderBy(asc(l2Block.height))
    .limit(1);
  if (!lowest) {
    return "head";
  }
  const walked: ChainBlock[] = [];
  let child = toChainBlock(lowest);
  for (let steps = 0; steps < WALK_BOUND; steps++) {
    await step(change);
    const parents = await storedParents(change, child);
    if (child.height === block.height + 1n) {
      if (parents.length > 1) {
        return "undecided";
      }
      return parents[0]?.hash === block.hash ? { walked } : "excludes";
    }
    const [parent] = parents;
    if (parents.length !== 1 || parent.canonical) {
      return "undecided";
    }
    walked.push(parent);
    child = parent;
  }
  return "undecided";
};

const storeIfAbsent = async (
  change: Change,
  block: ChicmozL2Block,
  { ordered }: { ordered: boolean },
): Promise<StoredBlock> => {
  const node = {
    hash: block.hash,
    height: block.height,
    version: change.version,
    archiveRoot: block.archive.root,
    lastArchiveRoot: block.header.lastArchive.root,
  };
  const [existing] = await change.dbTx
    .select({
      orphanTimestamp: l2Block.orphan_timestamp,
      archiveId: archive.id,
      archiveRoot: archive.root,
      bodyId: body.id,
    })
    .from(l2Block)
    .innerJoin(archive, eq(archive.fk, l2Block.hash))
    .innerJoin(body, eq(body.blockHash, l2Block.hash))
    .where(eq(l2Block.hash, block.hash))
    .limit(1);
  if (!existing) {
    const bodyId = await store(change.dbTx, block, change.now);
    return { ...node, canonical: false, bodyId, created: true };
  }
  const stored = {
    ...node,
    canonical: existing.orphanTimestamp === null,
    bodyId: existing.bodyId,
    created: false,
  };
  if (existing.archiveRoot === node.archiveRoot) {
    return stored;
  }
  // The archive root is outside the block hash: the ordered stream's copy wins.
  logger.warn(
    `Block ${block.height} (${block.hash}) arrived with archive root ${node.archiveRoot}, stored with ${existing.archiveRoot}; keeping the ${ordered ? "ordered" : "stored"} one`,
  );
  if (!ordered) {
    return { ...stored, archiveRoot: existing.archiveRoot };
  }
  await change.dbTx
    .update(archive)
    .set({
      root: block.archive.root,
      nextAvailableLeafIndex: block.archive.nextAvailableLeafIndex,
    })
    .where(eq(archive.id, existing.archiveId));
  return stored;
};

/**
 * Writes the block's tx effects from its message. A canonical block takes
 * every one, moving those that off-chain blocks hold; an off-chain block
 * only takes those no block holds.
 */
const attachTxs = async (
  change: Change,
  stored: StoredBlock,
  block: ChicmozL2Block,
  { canonical }: { canonical: boolean },
) => {
  const effects = block.body.txEffects;
  const owners = new Map(
    (
      await txOwners(
        change.dbTx,
        effects.map((e) => e.txHash),
      )
    ).map((o) => [o.txHash, o]),
  );
  if (canonical) {
    const conflicts = [...owners.values()].filter(
      (o) => o.canonical && o.blockHash !== block.hash,
    );
    if (conflicts.length > 0) {
      throw new TxConflict(block, conflicts);
    }
  }
  for (const [index, effect] of effects.entries()) {
    const owner = owners.get(effect.txHash);
    if (owner?.blockHash === block.hash || (owner && !canonical)) {
      continue;
    }
    await writeTxEffect(change.dbTx, {
      bodyId: stored.bodyId,
      index,
      effect,
      held: owner !== undefined,
    });
  }
};

const recordReorg = async (change: Change) => {
  const blocks = [...change.demoted]
    .map(([hash, height]) => ({ hash, height }))
    .sort((a, b) =>
      a.height === b.height
        ? a.hash.localeCompare(b.hash)
        : a.height < b.height
          ? -1
          : 1,
    );
  const [root] = blocks;
  const [record] = await change.dbTx
    .insert(l2ReorgTable)
    .values({
      l2NetworkId: L2_NETWORK_ID,
      rollupVersion: change.version,
      rootHeight: root.height,
      rootHash: root.hash,
      removedCount: blocks.length,
      observedAt: new Date(change.now),
    })
    .returning({ id: l2ReorgTable.id });
  await inStatements(change, blocks, async (part) => {
    await change.dbTx
      .insert(l2ReorgBlockTable)
      .values(part.map((b) => ({ reorgId: record.id, ...b })));
  });
  logger.warn(
    `L2 reorg at height ${root.height}: ${blocks.length} block(s) left the chain, the lowest ${root.hash}`,
  );
};

const markDemotedTxsDropped = async (change: Change) => {
  const orphaned = await ownedTxs(change, [...change.demoted.keys()]);
  await inStatements(change, orphaned, async (part) => {
    await change.dbTx
      .insert(droppedTx)
      .values(
        part.map(({ txHash, birth }) => ({
          txHash,
          createdAsPendingAt: birth,
          droppedAt: change.now,
          dropReason: "orphaned",
        })),
      )
      .onConflictDoNothing();
  });
};

/** A record is revived once every block it lists is stored and canonical again. */
const reviveRecords = async (change: Change) => {
  await inStatements(change, [...change.promoted.keys()], async (part) => {
    await change.dbTx
      .update(l2ReorgTable)
      .set({ revivedAt: new Date(change.now) })
      .where(
        and(
          eq(l2ReorgTable.l2NetworkId, L2_NETWORK_ID),
          isNull(l2ReorgTable.revivedAt),
          inArray(
            l2ReorgTable.id,
            change.dbTx
              .select({ id: l2ReorgBlockTable.reorgId })
              .from(l2ReorgBlockTable)
              .where(inArray(l2ReorgBlockTable.hash, part)),
          ),
          sql`NOT EXISTS (SELECT 1 FROM ${l2ReorgBlockTable} LEFT JOIN ${l2Block} ON ${l2Block.hash} = ${l2ReorgBlockTable.hash} WHERE ${l2ReorgBlockTable.reorgId} = ${l2ReorgTable.id} AND (${l2Block.hash} IS NULL OR ${l2Block.orphan_timestamp} IS NOT NULL))`,
        ),
      );
  });
};

const setHasOrphanedParent = async (
  change: Change,
  hashes: HexString[],
  value: boolean,
) => {
  await inStatements(change, hashes, async (part) => {
    await change.dbTx
      .update(l2Block)
      .set({ orphan_hasOrphanedParent: value })
      .where(
        and(inArray(l2Block.hash, part), isNotNull(l2Block.orphan_timestamp)),
      );
  });
};

/**
 * `orphan_hasOrphanedParent` of an off-chain block: its stored parent is off
 * the chain too. Refreshed for the blocks this call demoted or stored off the
 * chain, and for the off-chain children of those and of the blocks it made
 * canonical.
 */
const refreshOrphanFlags = async (change: Change, storedOff: HexString[]) => {
  const parent = alias(l2Block, "parent");
  const parentArchive = alias(archive, "parent_archive");
  const deadParent: HexString[] = [];
  await inStatements(
    change,
    [...change.demoted.keys(), ...storedOff],
    async (part) => {
      const rows = await change.dbTx
        .selectDistinct({ hash: l2Block.hash })
        .from(l2Block)
        .innerJoin(header, eq(header.blockHash, l2Block.hash))
        .innerJoin(lastArchive, eq(lastArchive.fk, header.id))
        .innerJoin(parentArchive, eq(parentArchive.root, lastArchive.root))
        .innerJoin(
          parent,
          and(
            eq(parent.hash, parentArchive.fk),
            eq(parent.height, sql`${l2Block.height} - 1`),
            eq(parent.version, l2Block.version),
          ),
        )
        .where(
          and(inArray(l2Block.hash, part), isNotNull(parent.orphan_timestamp)),
        );
      deadParent.push(...rows.map((r) => r.hash));
    },
  );

  const child = alias(l2Block, "child");
  const childHeader = alias(header, "child_header");
  const childLastArchive = alias(lastArchive, "child_last_archive");
  const moved = [
    ...change.demoted.keys(),
    ...change.promoted.keys(),
    ...storedOff,
  ];
  const liveParent: HexString[] = [];
  await inStatements(change, moved, async (part) => {
    const rows = await change.dbTx
      .selectDistinct({
        hash: child.hash,
        parentOrphanTimestamp: l2Block.orphan_timestamp,
      })
      .from(l2Block)
      .innerJoin(archive, eq(archive.fk, l2Block.hash))
      .innerJoin(childLastArchive, eq(childLastArchive.root, archive.root))
      .innerJoin(childHeader, eq(childHeader.id, childLastArchive.fk))
      .innerJoin(
        child,
        and(
          eq(child.hash, childHeader.blockHash),
          eq(child.height, sql`${l2Block.height} + 1`),
          eq(child.version, l2Block.version),
        ),
      )
      .where(
        and(inArray(l2Block.hash, part), isNotNull(child.orphan_timestamp)),
      );
    for (const row of rows) {
      (row.parentOrphanTimestamp === null ? liveParent : deadParent).push(
        row.hash,
      );
    }
  });
  await setHasOrphanedParent(change, deadParent, true);
  await setHasOrphanedParent(change, liveParent, false);
};

const settle = async (
  change: Change,
  block: ChicmozL2Block,
  { canonical, created }: { canonical: boolean; created: boolean },
) => {
  if (change.demoted.size > 0) {
    await recordReorg(change);
  }
  await markDemotedTxsDropped(change);
  const mined = new Set(
    (await ownedTxs(change, [...change.promoted.keys()])).map((t) => t.txHash),
  );
  if (canonical) {
    block.body.txEffects.forEach((e) => mined.add(e.txHash));
  }
  await inStatements(change, [...mined], (part) =>
    removePendingAndDroppedTx(change.dbTx, part, change.heartbeat),
  );
  await reviveRecords(change);
  await refreshOrphanFlags(change, created && !canonical ? [block.hash] : []);
  await inStatements(
    change,
    [...new Set([...change.walked.values(), ...change.repairs])],
    (part) => recordRepairHeights(change.dbTx, part),
  );
  if (canonical) {
    await fulfilRepairHeight(change.dbTx, block.height);
  }
};

const ownerSummary = (owners: TxOwner[]) =>
  owners
    .map((o) => `${o.txHash} in active block ${o.height} (${o.blockHash})`)
    .join(", ");

const apply = async (
  { block, contracts }: IncomingBlock,
  heartbeat: Heartbeat,
  { ordered }: { ordered: boolean },
  decide: (change: Change, stored: StoredBlock) => Promise<boolean>,
): Promise<ChainOutcome> => {
  try {
    return await withChainLock(async (dbTx) => {
      const change: Change = {
        dbTx,
        version: block.header.globalVariables.version,
        now: Date.now(),
        heartbeat,
        steps: 0,
        demoted: new Map(),
        promoted: new Map(),
        walked: new Map(),
        repairs: new Set(),
      };
      const stored = await storeIfAbsent(change, block, { ordered });
      const canonical = await decide(change, stored);
      await attachTxs(change, stored, block, { canonical });
      if (canonical) {
        await storeBlockContracts(dbTx, contracts, heartbeat);
      }
      await settle(change, block, { canonical, created: stored.created });
      logger.info(
        `🧢 Applied ${ordered ? "ordered" : "catch-up"} block ${block.height} (${block.hash}): ${canonical ? "canonical" : "off the chain"}; demoted ${change.demoted.size}, made canonical ${change.promoted.size}`,
      );
      return { canonical };
    });
  } catch (e) {
    if (e instanceof TxConflict) {
      logger.error(
        `SKIPPED_BLOCK_TX_CONFLICT height=${block.height} hash=${block.hash} owners=${ownerSummary(e.owners)}`,
      );
      return { canonical: false };
    }
    throw e;
  }
};

/**
 * An ordered block is canonical at its height. It replaces the block there
 * with that block's linked descendants, and every other canonical holder of
 * its txs with theirs; brings back its stored ancestors; asks for the heights
 * below it that this leaves empty; and demotes every canonical block above
 * `tip`.
 */
export const applyOrderedBlock = (
  incoming: IncomingBlock,
  tip: number,
  heartbeat: Heartbeat,
): Promise<ChainOutcome> => {
  const { height, hash } = incoming.block;
  let ceiling = BigInt(tip);
  if (ceiling < height) {
    logger.warn(
      `Ordered block ${height} (${hash}) carries tip ${tip}, below its height; using ${height}`,
    );
    ceiling = height;
  }
  return apply(
    incoming,
    heartbeat,
    { ordered: true },
    async (change, stored) => {
      if (!stored.canonical) {
        for (const replaced of await canonicalAt(change, height)) {
          await demoteLinkedRun(change, replaced, ceiling);
        }
      }
      await demoteHolders(change, incoming.block, ceiling);
      if (!stored.canonical) {
        await promote(change, stored, { walked: false });
        await reviveAncestors(change, stored);
      }
      await requestEmptied(change, height);
      await demoteAbove(change, ceiling);
      return true;
    },
  );
};

/**
 * A catch-up block never replaces the canonical block at its own height: it
 * joins only where that height is empty, below the canonical head. It joins
 * when the lowest canonical block above descends from it, and then has that
 * block's authority below its height, as an ordered block has below its
 * own: it demotes the other canonical holders of its txs there, with their
 * linked runs, brings back its stored ancestors in place of the blocks at
 * their heights, and asks for the heights left empty. With `final` (at or
 * below the serving node's own finalized tip), it also joins when the
 * canonical block below, if any, is its parent, and asks for that height
 * when it is empty. A canonical block with a canonical child linked to it,
 * as one a walk brought back, has the same authority: the holders of its
 * txs below it go, and the heights left empty are asked for.
 */
export const applyCatchupBlock = (
  incoming: IncomingBlock,
  final: boolean,
  heartbeat: Heartbeat,
): Promise<ChainOutcome> =>
  apply(incoming, heartbeat, { ordered: false }, async (change, stored) => {
    if (stored.canonical) {
      const children = await canonicalChildren(
        change,
        [stored],
        stored.height + 1n,
      );
      if (children.length > 0) {
        await demoteHolders(change, incoming.block, stored.height - 1n);
        await requestEmptied(change, stored.height);
      }
      return true;
    }
    if ((await canonicalAt(change, stored.height)).length > 0) {
      return false;
    }
    const link = await linkFromAbove(change, stored);
    if (link === "head") {
      return false;
    }
    if (link === "excludes") {
      if (final) {
        logger.warn(
          `CHAIN_LINK_CONFLICT: final catch-up block ${stored.height} (${stored.hash}) is not the parent of the canonical chain above it; left off the chain`,
        );
      }
      return false;
    }
    if (link !== "undecided") {
      await demoteHolders(change, incoming.block, stored.height - 1n);
      await promote(change, stored, { walked: false });
      for (const walked of link.walked) {
        await promote(change, walked, { walked: true });
      }
      await reviveAncestors(change, stored);
      await requestEmptied(change, stored.height);
      return true;
    }
    if (!final) {
      return false;
    }
    const below = await canonicalAt(change, stored.height - 1n);
    if (below.some((b) => b.archiveRoot !== stored.lastArchiveRoot)) {
      return false;
    }
    await promote(change, stored, { walked: false });
    if (below.length === 0 && stored.height > 1n) {
      change.repairs.add(stored.height - 1n);
    }
    return true;
  });
