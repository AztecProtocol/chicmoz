import { type Heartbeat } from "@chicmoz-pkg/message-bus";
import { type NewBlockEvent } from "@chicmoz-pkg/message-registry";
import { deliver } from "@chicmoz/test-harness";
import { BSON } from "bson";
import { type SQL } from "drizzle-orm";
import { Kafka, logLevel } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuiltBlock,
  buildBlock,
  buildChain,
  catchupEvent,
  freshTxHash,
  orderedEvent,
} from "./support/blocks.js";
import { heads, loadChainReads } from "./support/chain.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

// Each case runs on a rollup version of its own, because an ordered block
// demotes every canonical block of its version above its tip, and on heights
// of its own, because repair rows are per network.
let lastVersion = 1_000;
const freshVersion = () => ++lastVersion;

describe("the canonical chain on a real database", () => {
  let api: ExplorerApiForTest;
  let reads: Awaited<ReturnType<typeof loadChainReads>>;
  let ordered: (b: BuiltBlock, tip?: number) => Promise<void>;
  let catchup: (b: BuiltBlock, options?: { final?: true }) => Promise<void>;
  let orderedWith: (
    event: NewBlockEvent,
    heartbeat: Heartbeat,
  ) => Promise<void>;
  let ignoredUnordered: (b: BuiltBlock) => Promise<void>;
  let setOrphaned: (blocks: BuiltBlock[], orphaned: boolean) => Promise<void>;
  let bareChain: (chain: {
    version: number;
    from: bigint;
    count: number;
    parent?: BuiltBlock;
  }) => Promise<void>;
  let throughBroker: (
    event: NewBlockEvent,
  ) => Promise<{ deliveries: number; rebalances: number; beats: number }>;
  let holdChainLock: () => Promise<() => Promise<void>>;
  let walkBound: number;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler, catchupHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    const { WALK_BOUND, withChainLock } = await import(
      "../../src/svcs/database/controllers/l2block/canonical.js"
    );
    const { l2Block } = await import(
      "../../src/svcs/database/schema/l2block/index.js"
    );
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { inArray, sql } = await import("drizzle-orm");
    const db = getDb();
    reads = await loadChainReads();
    walkBound = WALK_BOUND;

    ordered = (b, tip) => deliver(blockHandler, orderedEvent(b, tip));
    catchup = (b, options) => deliver(catchupHandler, catchupEvent(b, options));
    orderedWith = (event, heartbeat) => blockHandler.cb(event, heartbeat);
    ignoredUnordered = (b) =>
      deliver(blockHandler, {
        block: b.hex,
        blockNumber: Number(b.height),
        statusHint: "proposed",
      } satisfies NewBlockEvent);
    setOrphaned = async (blocks, orphaned) => {
      await db
        .update(l2Block)
        .set({
          orphan_timestamp: orphaned ? Date.now() : null,
          orphan_hasOrphanedParent: orphaned ? false : null,
        })
        .where(
          inArray(
            l2Block.hash,
            blocks.map((b) => b.hash),
          ),
        );
    };
    // Canonical blocks with only the rows a link lookup reads, inserted in
    // bulk: delivering thousands of blocks would take minutes.
    bareChain = async ({ version, from, count, parent }) => {
      const to = from + BigInt(count - 1);
      const tag = version.toString(16).padStart(8, "0");
      const hashOf = (n: SQL) =>
        sql`'0x' || ${tag}::text || '00' || lpad(to_hex(${n}), 54, '0')`;
      const rootOf = (n: SQL) =>
        sql`'0x' || ${tag}::text || 'ff' || lpad(to_hex(${n}), 54, '0')`;
      const n = sql`n`;
      const heights = sql`generate_series(${from}::bigint, ${to}::bigint) AS n`;
      await db.execute(
        sql`INSERT INTO "l2Block" ("hash", "height", "version") SELECT ${hashOf(n)}, n, ${version}::bigint FROM ${heights}`,
      );
      await db.execute(
        sql`INSERT INTO "archive" ("root", "next_available_leaf_index", "block_hash") SELECT ${rootOf(n)}, 0, ${hashOf(n)} FROM ${heights}`,
      );
      await db.execute(
        sql`INSERT INTO "header" ("block_hash", "total_fees", "total_mana_used", "sponge_blob_hash") SELECT ${hashOf(n)}, 0, 0, '0x00' FROM ${heights}`,
      );
      const height = sql`b."height"`;
      const lowestLastArchive = parent
        ? sql`${parent.archive.root.toString()}::text`
        : rootOf(sql`${height} - 1`);
      await db.execute(
        sql`INSERT INTO "last_archive" ("root", "next_available_leaf_index", "header_id")
          SELECT CASE WHEN ${height} = ${from}::bigint THEN ${lowestLastArchive} ELSE ${rootOf(sql`${height} - 1`)} END, 0, h."id"
          FROM "header" h JOIN "l2Block" b ON b."hash" = h."block_hash"
          WHERE b."version" = ${version}::bigint AND ${height} BETWEEN ${from}::bigint AND ${to}::bigint AND b."hash" = ${hashOf(height)}`,
      );
    };
    const kafka = new Kafka({
      clientId: `${api.namespace}-chain-walk`,
      brokers: [api.stack.env.KAFKA_CONNECTION],
      sasl: {
        mechanism: "plain",
        username: api.stack.env.KAFKA_SASL_USERNAME,
        password: api.stack.env.KAFKA_SASL_PASSWORD,
      },
      logLevel: logLevel.NOTHING,
    });
    // Two members of one group whose session is shorter than a long walk:
    // only the handler's heartbeats keep the walking member, and losing it
    // would hand the partition, and the message again, to the other.
    throughBroker = async (event) => {
      const topic = `${api.namespace}.chain-walk`;
      const groupId = `${api.namespace}-chain-walk`;
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      const outcome = { deliveries: 0, rebalances: 0, beats: 0 };
      let sent = false;
      let settle: (error?: unknown) => void = () => undefined;
      const handled = new Promise<void>((resolve, reject) => {
        settle = (error) => (error === undefined ? resolve() : reject(error));
      });
      const members = [0, 1].map(() =>
        kafka.consumer({
          groupId,
          sessionTimeout: 6_000,
          heartbeatInterval: 1_000,
        }),
      );
      try {
        for (const member of members) {
          member.on(member.events.REBALANCING, () => {
            if (sent) {
              outcome.rebalances++;
            }
          });
          await member.connect();
          await member.subscribe({ topic, fromBeginning: true });
          await member.run({
            eachMessage: async ({ message, heartbeat }) => {
              outcome.deliveries++;
              try {
                await blockHandler.cb(
                  BSON.deserialize(
                    message.value ?? Buffer.alloc(0),
                  ) as NewBlockEvent,
                  () => {
                    outcome.beats++;
                    return heartbeat();
                  },
                );
                settle();
              } catch (e) {
                settle(e);
                throw e;
              }
            },
          });
        }
        const deadline = Date.now() + 30_000;
        for (;;) {
          const {
            groups: [group],
          } = await admin.describeGroups([groupId]);
          if (group?.state === "Stable" && group.members.length === 2) {
            break;
          }
          if (Date.now() > deadline) {
            throw new Error(`group ${groupId} never settled with both members`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        sent = true;
        const producer = kafka.producer();
        await producer.connect();
        await producer.send({
          topic,
          messages: [{ value: Buffer.from(BSON.serialize(event)) }],
        });
        await producer.disconnect();
        await handled;
        // Read once the broker holds the commit: a member lost before it
        // would have the message delivered again.
        const committedBy = Date.now() + 30_000;
        for (;;) {
          const offsets = await admin.fetchOffsets({
            groupId,
            topics: [topic],
          });
          if (offsets[0]?.partitions[0]?.offset === "1") {
            break;
          }
          if (Date.now() > committedBy) {
            throw new Error(`group ${groupId} never committed the message`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // Leaving the group below rebalances it too.
        return { ...outcome };
      } finally {
        for (const member of members) {
          await member.disconnect();
        }
        await admin.disconnect();
      }
    };
    holdChainLock = async () => {
      let release: () => void = () => undefined;
      let held: Promise<void> = Promise.resolve();
      await new Promise<void>((locked) => {
        held = withChainLock(() => {
          locked();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        });
      });
      return async () => {
        release();
        await held;
      };
    };
  });

  afterAll(async () => {
    await api?.close();
  });

  it("replaces the block at its height and its linked descendants, and demotes every block above its tip, in one record", async () => {
    const version = freshVersion();
    const a = await buildChain(1_000n, 4, { version });
    const above = await buildBlock(1_005n, [freshTxHash()], { version });
    for (const block of [...a, above]) {
      await ordered(block);
    }
    const b1 = await buildBlock(1_001n, [freshTxHash()], {
      version,
      parent: a[0],
    });

    await ordered(b1, 1_002);

    expect(await reads.chainOf(version)).toEqual(heads([a[0], b1]));
    expect(await reads.recordsOf(version)).toEqual([
      { active: true, blocks: [a[1], a[2], a[3], above].map((b) => b.hash) },
    ]);
    expect(
      await Promise.all([a[1], a[2], above].map((b) => reads.stateOf(b.hash))),
    ).toEqual([
      { hasOrphanedParent: false },
      { hasOrphanedParent: true },
      { hasOrphanedParent: false },
    ]);
  });

  it("changes nothing for an ordered block already canonical, and ends a replay and a flip with the listener's chain and one active record", async () => {
    const version = freshVersion();
    const a = await buildChain(2_000n, 4, { version });
    const b = await buildChain(2_001n, 2, { version, parent: a[0] });
    const pass = async () => {
      for (const block of a) {
        await ordered(block);
      }
      for (const block of b) {
        await ordered(block, 2_002);
      }
    };
    const active = async () =>
      (await reads.recordsOf(version))
        .filter((r) => r.active)
        .map((r) => r.blocks);
    await pass();
    expect(await reads.chainOf(version)).toEqual(heads([a[0], ...b]));
    expect(await active()).toEqual([[a[1], a[2], a[3]].map((x) => x.hash)]);

    await ordered(b[1], 2_002);
    expect(await reads.chainOf(version)).toEqual(heads([a[0], ...b]));
    expect(await reads.recordsOf(version)).toHaveLength(1);

    await pass();
    expect(await reads.chainOf(version)).toEqual(heads([a[0], ...b]));
    expect(await active()).toEqual([[a[1], a[2], a[3]].map((x) => x.hash)]);

    for (const block of a.slice(1)) {
      await ordered(block, 2_003);
    }
    expect(await reads.chainOf(version)).toEqual(heads(a));
    expect(await active()).toEqual([b.map((x) => x.hash)]);
  });

  it("demotes the old blocks above the tip with the first replacing block, and those between a gap and the tip when the pass reaches them", async () => {
    const version = freshVersion();
    const [a0, a1, missing, a3, a4] = await buildChain(3_000n, 5, { version });
    for (const block of [a0, a1, a3, a4]) {
      await ordered(block);
    }
    expect(await reads.stateOf(missing.hash)).toBe("absent");
    const b = await buildChain(3_001n, 3, { version, parent: a0 });

    await ordered(b[0], 3_003);
    expect(await reads.chainOf(version)).toEqual(heads([a0, b[0], a3]));
    expect(await reads.recordsOf(version)).toEqual([
      { active: true, blocks: [a1.hash, a4.hash] },
    ]);

    await ordered(b[1], 3_003);
    await ordered(b[2], 3_003);
    expect(await reads.chainOf(version)).toEqual(heads([a0, ...b]));
    expect(await reads.recordsOf(version)).toEqual([
      { active: true, blocks: [a1.hash, a4.hash] },
      { active: true, blocks: [a3.hash] },
    ]);
  });

  it("never demotes the live chain above a gap for an ordered block below it", async () => {
    const version = freshVersion();
    const live = await buildChain(4_000n, 4, { version });
    await ordered(live[2]);
    await ordered(live[3]);

    await ordered(live[0], 4_003);
    expect(await reads.chainOf(version)).toEqual(
      heads([live[0], live[2], live[3]]),
    );

    await ordered(live[1], 4_003);
    expect(await reads.chainOf(version)).toEqual(heads(live));
    expect(await reads.recordsOf(version)).toEqual([]);
  });

  it("keeps a final catch-up block at a canonical height off the chain until its ordered copy arrives", async () => {
    const version = freshVersion();
    const a = await buildChain(5_000n, 3, { version });
    for (const block of a) {
      await ordered(block);
    }
    const b1 = await buildBlock(5_001n, [freshTxHash()], {
      version,
      parent: a[0],
    });

    await catchup(b1, { final: true });
    expect(await reads.chainOf(version)).toEqual(heads(a));
    expect(await reads.recordsOf(version)).toEqual([]);

    await ordered(b1);
    expect(await reads.chainOf(version)).toEqual(heads([a[0], b1]));
    expect(await reads.recordsOf(version)).toEqual([
      { active: true, blocks: [a[1].hash, a[2].hash] },
    ]);
  });

  it("joins a catch-up block at an empty height only when the chain above descends from it", async () => {
    const version = freshVersion();
    const c = await buildChain(6_000n, 4, { version });
    for (const block of [c[0], c[2], c[3]]) {
      await ordered(block);
    }
    const stranger = await buildBlock(6_001n, [freshTxHash()], {
      version,
      parent: c[0],
    });

    await catchup(stranger, { final: true });
    expect(await reads.stateOf(stranger.hash)).toEqual({
      hasOrphanedParent: false,
    });

    await catchup(c[1]);
    expect(await reads.chainOf(version)).toEqual(heads(c));
    expect(await reads.recordsOf(version)).toEqual([]);
    expect(await reads.ownerOf(c[1].txHashes[0])).toBe(c[1].hash);
  });

  it("keeps a final catch-up block above the canonical head off the chain", async () => {
    const version = freshVersion();
    const [head, above] = await buildChain(16_000n, 2, { version });
    await ordered(head);

    await catchup(above, { final: true });

    expect(await reads.chainOf(version)).toEqual(heads([head]));
  });

  it("demotes the block below a catch-up block joined from above when it is not its parent, and requests the parent", async () => {
    const version = freshVersion();
    const [a0, a1] = await buildChain(17_000n, 2, { version });
    const b1 = await buildBlock(17_001n, [freshTxHash()], {
      version,
      parent: a0,
    });
    const [b2, b3] = await buildChain(17_002n, 2, { version, parent: b1 });
    await ordered(a0);
    await ordered(a1);
    await ordered(b3);

    await catchup(b2);

    expect(await reads.chainOf(version)).toEqual(heads([a0, b2, b3]));
    expect(await reads.recordsOf(version)).toEqual([
      { active: true, blocks: [a1.hash] },
    ]);
    expect(await reads.repairOpen(17_001)).toBe(true);
  });

  it("walks repairs back from an ordered block far above the head, one per attach, until they meet the old chain", async () => {
    const version = freshVersion();
    const [a0, a1] = await buildChain(18_000n, 2, { version });
    const b = await buildChain(18_001n, 5, { version, parent: a0 });
    await ordered(a0);
    await ordered(a1);
    await ordered(b[4]);

    for (const block of b.slice(0, 4).reverse()) {
      const height = Number(block.height);
      expect([
        await reads.repairOpen(height),
        await reads.repairOpen(height - 1),
      ]).toEqual([true, false]);
      await catchup(block);
    }

    expect(await reads.chainOf(version)).toEqual(heads([a0, ...b]));
    expect(await reads.repairOpen(18_001)).toBe(false);
  });

  it("fills history from block 1 with final catch-up blocks, each only on the canonical block below as its parent", async () => {
    const version = freshVersion();
    const c = await buildChain(1n, 6, { version });
    await ordered(c[4], 6);
    await ordered(c[5], 6);
    const stranger = await buildBlock(3n, [freshTxHash()], { version });

    for (const block of [c[0], c[1], stranger, c[2], c[3]]) {
      await catchup(block, { final: true });
    }

    expect(await reads.chainOf(version)).toEqual(heads(c));
    expect(await reads.stateOf(stranger.hash)).toEqual({
      hasOrphanedParent: false,
    });
    expect(await reads.recordsOf(version)).toEqual([]);
  });

  it("clears the dropped rows of the effects a walk-made-canonical block owns, and attaches the rest from its repair", async () => {
    const version = freshVersion();
    const kept = freshTxHash();
    const shared = freshTxHash();
    const a0 = await buildBlock(7_000n, [freshTxHash()], { version });
    const a1 = await buildBlock(7_001n, [kept, shared], {
      version,
      parent: a0,
    });
    const b1 = await buildBlock(7_001n, [shared], { version, parent: a0 });
    const a2 = await buildBlock(7_002n, [freshTxHash()], {
      version,
      parent: a1,
    });
    await ordered(a0);
    await ordered(a1);
    await ordered(b1);
    expect(await reads.isDropped(kept)).toBe(true);
    expect(await reads.ownerOf(shared)).toBe(b1.hash);

    await ordered(a2);
    expect(await reads.chainOf(version)).toEqual(heads([a0, a1, a2]));
    expect(await reads.isDropped(kept)).toBe(false);
    expect(await reads.ownerOf(shared)).toBe(b1.hash);
    expect(await reads.isDropped(shared)).toBe(true);
    expect(await reads.repairOpen(7_001)).toBe(true);

    await catchup(a1);
    expect(await reads.ownerOf(shared)).toBe(a1.hash);
    expect(await reads.isDropped(shared)).toBe(false);
    expect(await reads.repairOpen(7_001)).toBe(false);
  });

  it("brings back a live block the old code orphaned without demoting the chain above it", async () => {
    const version = freshVersion();
    const live = await buildChain(8_000n, 5, { version });
    const wrong = await buildChain(8_001n, 2, { version, parent: live[0] });
    for (const block of live) {
      await ordered(block);
    }
    for (const block of wrong) {
      await catchup(block);
    }
    // What the height rule left behind: live blocks orphaned under wrong ones.
    await setOrphaned([live[1], live[2]], true);
    await setOrphaned(wrong, false);

    await ordered(live[2], 8_004);

    expect(await reads.chainOf(version)).toEqual(heads(live));
    expect(await reads.recordsOf(version)).toEqual([
      { active: true, blocks: wrong.map((b) => b.hash) },
    ]);
  });

  it("keeps a partly revived record active with only its blocks still off the chain, and lists a block that died twice once", async () => {
    const version = freshVersion();
    const a = await buildChain(9_000n, 4, { version });
    const b1 = await buildBlock(9_001n, [freshTxHash()], {
      version,
      parent: a[0],
    });
    for (const block of a) {
      await ordered(block);
    }
    await ordered(b1);

    await ordered(a[1]);
    expect((await reads.recordsOf(version)).map((r) => r.active)).toEqual([
      true,
      true,
    ]);
    expect(await reads.listed([...a, b1])).toEqual([
      { orphanedBlockHash: b1.hash, height: 9_001n, nbrOfOrphanedBlocks: 1 },
      { orphanedBlockHash: a[2].hash, height: 9_002n, nbrOfOrphanedBlocks: 2 },
    ]);

    await ordered(b1);
    expect(await reads.listed([...a, b1])).toEqual([
      { orphanedBlockHash: a[1].hash, height: 9_001n, nbrOfOrphanedBlocks: 1 },
      { orphanedBlockHash: a[2].hash, height: 9_002n, nbrOfOrphanedBlocks: 2 },
    ]);
  });

  it("demotes a canonical holder of an ordered block's tx above it, across a gap, so no block of the pass is skipped", async () => {
    const version = freshVersion();
    const [x, y] = [freshTxHash(), freshTxHash()];
    const a5 = await buildBlock(10_005n, [freshTxHash()], { version });
    const a6 = await buildBlock(10_006n, [freshTxHash()], {
      version,
      parent: a5,
    });
    const a7 = await buildBlock(10_007n, [freshTxHash()], {
      version,
      parent: a6,
    });
    const a8 = await buildBlock(10_008n, [x, y], { version, parent: a7 });
    for (const block of [a5, a6, a8]) {
      await ordered(block);
    }
    const b6 = await buildBlock(10_006n, [x], { version, parent: a5 });
    const b7 = await buildBlock(10_007n, [y], { version, parent: b6 });
    const b8 = await buildBlock(10_008n, [freshTxHash()], {
      version,
      parent: b7,
    });

    for (const block of [b6, b7, b8]) {
      await ordered(block, 10_008);
    }

    expect(await reads.chainOf(version)).toEqual(heads([a5, b6, b7, b8]));
    expect([await reads.ownerOf(x), await reads.ownerOf(y)]).toEqual([
      b6.hash,
      b7.hash,
    ]);
  });

  it("demotes a stale canonical holder of an ordered block's tx below it, and requests the heights that leaves empty", async () => {
    const version = freshVersion();
    const x = freshTxHash();
    const a0 = await buildBlock(15_000n, [freshTxHash()], { version });
    const a1 = await buildBlock(15_001n, [x], { version, parent: a0 });
    const a2 = await buildBlock(15_002n, [freshTxHash()], {
      version,
      parent: a1,
    });
    const a3 = await buildBlock(15_003n, [freshTxHash()], {
      version,
      parent: a2,
    });
    for (const block of [a0, a1, a2, a3]) {
      await ordered(block);
    }
    const b1 = await buildBlock(15_001n, [freshTxHash()], {
      version,
      parent: a0,
    });
    const b2 = await buildBlock(15_002n, [freshTxHash()], {
      version,
      parent: b1,
    });
    const b3 = await buildBlock(15_003n, [x], { version, parent: b2 });

    await ordered(b3);

    expect(await reads.chainOf(version)).toEqual(heads([a0, b3]));
    expect(await reads.ownerOf(x)).toBe(b3.hash);
    expect([
      await reads.repairOpen(15_001),
      await reads.repairOpen(15_002),
    ]).toEqual([true, true]);
  });

  it("demotes a stale canonical holder of a tx below a catch-up block joined from above, and requests the heights that leaves empty", async () => {
    const version = freshVersion();
    const x = freshTxHash();
    const a0 = await buildBlock(21_000n, [freshTxHash()], { version });
    const a1 = await buildBlock(21_001n, [x], { version, parent: a0 });
    const a2 = await buildBlock(21_002n, [freshTxHash()], {
      version,
      parent: a1,
    });
    for (const block of [a0, a1, a2]) {
      await ordered(block);
    }
    const b1 = await buildBlock(21_001n, [freshTxHash()], {
      version,
      parent: a0,
    });
    const b2 = await buildBlock(21_002n, [freshTxHash()], {
      version,
      parent: b1,
    });
    const b3 = await buildBlock(21_003n, [x], { version, parent: b2 });
    const b4 = await buildBlock(21_004n, [freshTxHash()], {
      version,
      parent: b3,
    });
    await ordered(b4);

    await catchup(b3);

    expect(await reads.chainOf(version)).toEqual(heads([a0, b3, b4]));
    expect(await reads.ownerOf(x)).toBe(b3.hash);
    expect([
      await reads.repairOpen(21_001),
      await reads.repairOpen(21_002),
    ]).toEqual([true, true]);
  });

  it("treats a parent lookup that finds two blocks as a missing parent", async () => {
    const version = freshVersion();
    const [p] = await buildChain(11_000n, 1, { version });
    const twin = await buildBlock(11_001n, [freshTxHash()], {
      version,
      parent: p,
    });
    const other = await buildBlock(11_001n, [freshTxHash()], {
      version,
      parent: p,
      archive: twin.archive,
    });
    const child = await buildBlock(11_002n, [freshTxHash()], {
      version,
      parent: twin,
    });
    await ordered(p);
    await catchup(twin);
    await catchup(other);
    await ordered(child);
    expect(await reads.chainOf(version)).toEqual(heads([p, child]));

    await catchup(twin);
    expect(await reads.chainOf(version)).toEqual(heads([p, child]));

    await catchup(twin, { final: true });
    expect(await reads.chainOf(version)).toEqual(heads([p, twin, child]));
  });

  it("ignores a block event that is not from the ordered stream", async () => {
    const version = freshVersion();
    const [block] = await buildChain(12_000n, 1, { version });

    await ignoredUnordered(block);

    expect(await reads.stateOf(block.hash)).toBe("absent");
  });

  it("leaves one canonical block when the block and catch-up consumers store one height at once", async () => {
    // Ten heights at once, so that without the lock some height's two
    // transactions overlap.
    const races = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const version = freshVersion();
        const [p] = await buildChain(13_000n, 1, { version });
        const [fromStream, fromCatchup] = await Promise.all(
          [0, 1].map(() =>
            buildBlock(13_001n, [freshTxHash()], { version, parent: p }),
          ),
        );
        return { version, p, fromStream, fromCatchup };
      }),
    );
    for (const { p } of races) {
      await ordered(p);
    }

    await Promise.all(
      races.flatMap(({ fromStream, fromCatchup }) => [
        ordered(fromStream),
        catchup(fromCatchup, { final: true }),
      ]),
    );

    for (const { version, p, fromStream } of races) {
      expect(await reads.chainOf(version)).toEqual(heads([p, fromStream]));
    }
  });

  describe("bounds", () => {
    it("stops a walk at the bound without throwing, keeps its partition through it, and rolls back when a heartbeat fails", async () => {
      const version = freshVersion();
      const from = 100_000n;
      const [base] = await buildChain(from, 1, { version });
      await ordered(base);
      await bareChain({
        version,
        from: from + 1n,
        count: walkBound + 2,
        parent: base,
      });
      const replacing = await buildBlock(from + 1n, [freshTxHash()], {
        version,
        parent: base,
      });
      const event = orderedEvent(replacing, Number(from) + 2 * walkBound);

      await expect(
        orderedWith(event, () => Promise.reject(new Error("rebalancing"))),
      ).rejects.toThrow("rebalancing");
      expect(await reads.stateOf(replacing.hash)).toBe("absent");

      const { beats, ...delivery } = await throughBroker(event);

      expect(delivery).toEqual({ deliveries: 1, rebalances: 0 });
      expect(beats).toBeGreaterThanOrEqual(walkBound / 500);
      const chain = await reads.chainOf(version);
      expect(chain.slice(0, 2)).toEqual(heads([base, replacing]));
      expect(chain.slice(2).map((b) => b.height)).toEqual([
        from + BigInt(walkBound) + 2n,
      ]);
    }, 300_000);

    it("throws, changing nothing, on more canonical blocks above a tip than the bound, and heartbeats through demoting exactly the bound", async () => {
      const version = freshVersion();
      const from = 200_000n;
      await bareChain({ version, from: from + 1n, count: walkBound + 1 });
      const [block] = await buildChain(from, 1, { version });

      await expect(ordered(block)).rejects.toThrow(
        `More than ${walkBound} canonical blocks`,
      );
      expect(await reads.stateOf(block.hash)).toBe("absent");
      expect(await reads.chainOf(version)).toHaveLength(walkBound + 1);

      // No walk to heartbeat in: one replaced block, the bound above the tip.
      const replacing = await buildBlock(from + 1n, [freshTxHash()], {
        version,
      });
      let beats = 0;
      await orderedWith(orderedEvent(replacing), () => {
        beats++;
        return Promise.resolve();
      });

      expect(await reads.chainOf(version)).toEqual(heads([replacing]));
      expect(beats).toBeGreaterThan(0);
    }, 300_000);

    it("rethrows a chain lock wait over 10 s", async () => {
      const version = freshVersion();
      const [block] = await buildChain(300_000n, 1, { version });
      const release = await holdChainLock();
      try {
        await expect(ordered(block)).rejects.toThrow("lock timeout");
      } finally {
        await release();
      }
      expect(await reads.stateOf(block.hash)).toBe("absent");
    }, 30_000);
  });
});
