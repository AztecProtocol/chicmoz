import {
  BlockNumber,
  CheckpointNumber,
} from "@aztec-labs/foundation/branded-types";
import {
  type BlockHash,
  type CheckpointId,
  type L2BlockTag,
  L2TipsStoreBase,
} from "@aztec-labs/stdlib/block";
import { and, eq, lt } from "drizzle-orm";
import {
  l2BlockStreamHashTable as hashes,
  l2BlockStreamTipTable as tips,
} from "./schema.js";
import { db, inTransaction } from "./transaction.js";

/** The SDK block stream's local chain view, in Postgres, scoped to one rollup version. */
export class PostgresL2TipsStore extends L2TipsStoreBase {
  constructor(
    private readonly rollupVersion: number,
    initialBlockHash: BlockHash,
  ) {
    super(initialBlockHash);
  }

  /** False until a stream has stored a tip for any rollup version. */
  public async anyVersionStored(): Promise<boolean> {
    const rows = await db().select({ tag: tips.tag }).from(tips).limit(1);
    return rows.length > 0;
  }

  /** Joins an enclosing listener transaction, so callers can commit other writes with the store's. */
  public override runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return inTransaction(fn);
  }

  protected async getTip(tag: L2BlockTag): Promise<BlockNumber | undefined> {
    const rows = await db()
      .select({ blockNumber: tips.blockNumber })
      .from(tips)
      .where(this.tipRow(tag));
    return rows.length === 0 ? undefined : BlockNumber(rows[0].blockNumber);
  }

  protected async setTip(
    tag: L2BlockTag,
    blockNumber: BlockNumber,
  ): Promise<void> {
    await db()
      .insert(tips)
      .values({ rollupVersion: this.rollupVersion, tag, blockNumber })
      .onConflictDoUpdate({
        target: [tips.rollupVersion, tips.tag],
        set: { blockNumber },
      });
  }

  protected async getTipCheckpoint(
    tag: L2BlockTag,
  ): Promise<CheckpointId | undefined> {
    const rows = await db()
      .select({ number: tips.checkpointNumber, hash: tips.checkpointHash })
      .from(tips)
      .where(this.tipRow(tag));
    if (rows.length === 0) {
      return undefined;
    }
    const { number, hash } = rows[0];
    return number === null || hash === null
      ? undefined
      : { number: CheckpointNumber(number), hash };
  }

  // The base class sets a tip before its checkpoint, so a missing row is corruption.
  protected async setTipCheckpoint(
    tag: L2BlockTag,
    checkpoint: CheckpointId,
  ): Promise<void> {
    const updated = await db()
      .update(tips)
      .set({
        checkpointNumber: checkpoint.number,
        checkpointHash: checkpoint.hash,
      })
      .where(this.tipRow(tag))
      .returning({ tag: tips.tag });
    if (updated.length === 0) {
      throw new Error(
        `No ${tag} tip to record checkpoint ${checkpoint.number} on`,
      );
    }
  }

  protected async getStoredBlockHash(
    blockNumber: BlockNumber,
  ): Promise<string | undefined> {
    const rows = await db()
      .select({ blockHash: hashes.blockHash })
      .from(hashes)
      .where(
        and(
          eq(hashes.rollupVersion, this.rollupVersion),
          eq(hashes.blockNumber, blockNumber),
        ),
      );
    return rows.at(0)?.blockHash;
  }

  protected async setBlockHash(
    blockNumber: BlockNumber,
    hash: string,
  ): Promise<void> {
    await db()
      .insert(hashes)
      .values({
        rollupVersion: this.rollupVersion,
        blockNumber,
        blockHash: hash,
      })
      .onConflictDoUpdate({
        target: [hashes.rollupVersion, hashes.blockNumber],
        set: { blockHash: hash },
      });
  }

  protected async deleteBlockHashesBefore(
    blockNumber: BlockNumber,
  ): Promise<void> {
    await db()
      .delete(hashes)
      .where(
        and(
          eq(hashes.rollupVersion, this.rollupVersion),
          lt(hashes.blockNumber, blockNumber),
        ),
      );
  }

  private tipRow(tag: L2BlockTag) {
    return and(eq(tips.rollupVersion, this.rollupVersion), eq(tips.tag, tag));
  }
}
