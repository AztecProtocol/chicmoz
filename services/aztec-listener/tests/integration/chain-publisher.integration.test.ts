import { randomBytes } from "node:crypto";
import {
  BlockNumber,
  CheckpointNumber,
} from "@aztec-labs/foundation/branded-types";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import {
  type L2BlockId,
  type L2BlockStreamEvent,
  L2Block,
  type L2Tips,
} from "@aztec-labs/stdlib/block";
import { attach, createDatabase } from "@chicmoz/test-harness";
import { type MicroserviceBaseSvc } from "@chicmoz-pkg/microservice-base";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { TEMPLATE_DB } from "./support/constants.js";

type Modules = {
  store: typeof import("../../src/svcs/database/l2-tips-store.js");
  heights: typeof import("../../src/svcs/database/heights.controller.js");
  transaction: typeof import("../../src/svcs/database/transaction.js");
  publisher: typeof import("../../src/svcs/poller/pollers/block_poller/chain-publisher.js");
};

const VERSION = 11;
// Each test gets a store of its own version in the file's database.
let nextVersion = VERSION;
let modules: Modules;
let database: MicroserviceBaseSvc;

beforeAll(async () => {
  const stack = attach(inject("harnessStack"));
  const dbName = `t_${randomBytes(4).toString("hex")}`;
  await createDatabase(stack, dbName, { template: TEMPLATE_DB });
  Object.assign(process.env, stack.env, {
    POSTGRES_DB_NAME: dbName,
    L2_NETWORK_ID: "SANDBOX",
  });
  // These modules read their environment at import.
  const { MicroserviceBaseSvcState, setLogger, setSvcState } = await import(
    "@chicmoz-pkg/microservice-base"
  );
  const { logger } = await import("../../src/logger.js");
  setLogger(logger);
  ({ databaseService: database } = await import(
    "../../src/svcs/database/index.js"
  ));
  setSvcState(database.svcId, MicroserviceBaseSvcState.INITIALIZING);
  await database.init();
  setSvcState(database.svcId, MicroserviceBaseSvcState.UP);
  modules = {
    store: await import("../../src/svcs/database/l2-tips-store.js"),
    heights: await import("../../src/svcs/database/heights.controller.js"),
    transaction: await import("../../src/svcs/database/transaction.js"),
    publisher: await import(
      "../../src/svcs/poller/pollers/block_poller/chain-publisher.js"
    ),
  };
  await modules.heights.ensureInitializedBlockHeights();
});

afterAll(async () => {
  await database.shutdown();
});

const idOf = async (block: L2Block): Promise<L2BlockId> => ({
  number: block.number,
  hash: (await block.hash()).toString(),
});

const tierOf = async (block: L2Block) => ({
  block: await idOf(block),
  checkpoint: {
    number: CheckpointNumber(block.number),
    hash: `0x${block.number.toString(16).padStart(64, "0")}`,
  },
});

/**
 * A fresh store holding blocks 1-8, proven at 6, the proven cursor at 6, and
 * a publisher whose cursor write fails after it lands when `failCursor` is set.
 */
const arrange = async (failCursor: boolean) => {
  const blocks = await Promise.all(
    Array.from({ length: 9 }, (_, n) =>
      L2Block.random(BlockNumber(n), { txsPerBlock: 0 }),
    ),
  );
  const version = nextVersion++;
  const store = new modules.store.PostgresL2TipsStore(
    version,
    await blocks[0].hash(),
  );
  await store.handleBlockStreamEvent({
    type: "blocks-added",
    blocks: blocks.slice(1),
  });
  await store.handleBlockStreamEvent({
    type: "chain-proven",
    ...(await tierOf(blocks[6])),
  });
  await modules.heights.storeProcessedProvenBlockHeight(6);
  const snapshot: L2Tips = {
    proposed: { number: BlockNumber(9), hash: Fr.random().toString() },
    checkpointed: await tierOf(blocks[8]),
    proven: await tierOf(blocks[4]),
    finalized: await tierOf(blocks[0]),
  };
  const publisher = new modules.publisher.ChainPublisher({
    rollupVersion: version,
    store,
    source: {
      pinned: undefined,
      lastTips: snapshot,
      pinnedBlockData: vi.fn(),
      pinnedBlockDataUnbenched: vi.fn(),
      benchPinnedUntilNewTip: vi.fn(),
      benchPinnedPastNextElection: vi.fn(),
      setAsidePinned: vi.fn(),
    },
    publishBlock: () => Promise.resolve(),
    lowerProvenCursor: async (height) => {
      await modules.heights.lowerProcessedProvenBlockHeight(height);
      if (failCursor) {
        throw new Error("injected after the cursor write");
      }
    },
    transaction: modules.transaction.inTransaction,
  });
  const state = async () => ({
    tips: await store.getL2Tips(),
    hashes: await Promise.all(
      blocks.map((_, n) => store.getL2BlockHash(BlockNumber(n))),
    ),
    cursor: (await modules.heights.getBlockHeights())
      .processedProvenBlockHeight,
  });
  return { blocks, snapshot, publisher, state };
};

const pruneTo = async (
  blocks: L2Block[],
  snapshot: L2Tips,
): Promise<L2BlockStreamEvent> => ({
  type: "chain-pruned",
  block: await idOf(blocks[5]),
  checkpointed: snapshot.checkpointed,
  proven: snapshot.proven,
});

describe("ChainPublisher on Postgres", () => {
  it.each([
    {
      change: "a prune",
      event: (blocks: L2Block[], snapshot: L2Tips) => pruneTo(blocks, snapshot),
    },
    {
      change: "a proof that moves back",
      event: async (blocks: L2Block[]): Promise<L2BlockStreamEvent> => ({
        type: "chain-proven",
        ...(await tierOf(blocks[4])),
      }),
    },
  ])(
    "rolls back $change and the proven cursor together when a write after the store's fails",
    async ({ event }) => {
      const { blocks, snapshot, publisher, state } = await arrange(true);
      const before = await state();

      await expect(
        publisher.handleBlockStreamEvent(await event(blocks, snapshot)),
      ).rejects.toThrow("injected after the cursor write");

      expect(await state()).toEqual(before);
    },
  );

  it("stores a prune and moves the proven cursor back to its proven tip in one transaction", async () => {
    const { blocks, snapshot, publisher, state } = await arrange(false);

    await publisher.handleBlockStreamEvent(await pruneTo(blocks, snapshot));

    const after = await state();
    expect(after.tips.proposed).toEqual(await idOf(blocks[5]));
    expect(after.tips.proven.block).toEqual(await idOf(blocks[4]));
    expect(after.cursor).toBe(4);
    await modules.heights.lowerProcessedProvenBlockHeight(7);
    expect((await state()).cursor).toBe(4);
  });
});
