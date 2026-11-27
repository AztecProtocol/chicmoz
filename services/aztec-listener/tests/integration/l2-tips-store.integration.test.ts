import { randomBytes } from "node:crypto";
import {
  BlockNumber,
  CheckpointNumber,
} from "@aztec-labs/foundation/branded-types";
import {
  type BlockHash,
  type L2BlockId,
  type L2BlockStreamEvent,
  L2Block,
  L2TipsMemoryStore,
  type L2TipsStoreBase,
} from "@aztec-labs/stdlib/block";
import { attach, createDatabase } from "@chicmoz/test-harness";
import { type MicroserviceBaseSvc } from "@chicmoz-pkg/microservice-base";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TEMPLATE_DB } from "./support/constants.js";

type StoreClass =
  (typeof import("../../src/svcs/database/l2-tips-store.js"))["PostgresL2TipsStore"];

// Above the int4 range: the column must hold any version node info reports.
const VERSION = 3_456_789_012;
let PostgresL2TipsStore: StoreClass;
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
  ({ PostgresL2TipsStore } = await import(
    "../../src/svcs/database/l2-tips-store.js"
  ));
});

afterAll(async () => {
  await database.shutdown();
});

const randomChain = (from: number, to: number) =>
  Promise.all(
    Array.from({ length: to - from + 1 }, (_, i) =>
      L2Block.random(BlockNumber(from + i)),
    ),
  );

const idOf = async (block: L2Block): Promise<L2BlockId> => ({
  number: block.number,
  hash: (await block.hash()).toString(),
});

const checkpoint = (n: number) => ({
  number: CheckpointNumber(n),
  hash: `0x${n.toString(16).padStart(64, "0")}`,
});

const tipOf = async (block: L2Block, n: number) => ({
  block: await idOf(block),
  checkpoint: checkpoint(n),
});

const view = async (store: L2TipsStoreBase) => ({
  tips: await store.getL2Tips(),
  hashes: await Promise.all(
    Array.from({ length: 8 }, (_, n) => store.getL2BlockHash(BlockNumber(n))),
  ),
});

describe("PostgresL2TipsStore", () => {
  it("matches the SDK's memory store through persist, restart, prune clamp, finalized deletion and a new version", async () => {
    const genesis: BlockHash = await (
      await L2Block.random(BlockNumber(0))
    ).hash();
    const [b1, b2, b3, b4, b5] = await randomChain(1, 5);
    const replacing = await randomChain(4, 6);
    const memory = new L2TipsMemoryStore(genesis);
    let postgres = new PostgresL2TipsStore(VERSION, genesis);
    const apply = async (event: L2BlockStreamEvent) => {
      await memory.handleBlockStreamEvent(event);
      await postgres.handleBlockStreamEvent(event);
    };

    expect(await postgres.otherVersionStored()).toBe(false);
    await apply({ type: "blocks-added", blocks: [b1, b2, b3, b4, b5] });
    expect(await postgres.otherVersionStored()).toBe(false);
    await apply({
      type: "chain-checkpointed",
      block: await idOf(b4),
      checkpoint: checkpoint(4),
    });
    await apply({
      type: "chain-proven",
      block: await idOf(b3),
      checkpoint: checkpoint(3),
    });
    await apply({
      type: "chain-finalized",
      block: await idOf(b2),
      checkpoint: checkpoint(2),
    });
    const afterFinalized = await view(postgres);
    expect(afterFinalized).toEqual(await view(memory));
    expect(afterFinalized.hashes[0]).toBe(genesis.toString());
    expect(afterFinalized.hashes[1]).toBeUndefined();
    expect(afterFinalized.tips.finalized.block.number).toBe(2);

    postgres = new PostgresL2TipsStore(VERSION, genesis);
    expect(await view(postgres)).toEqual(afterFinalized);

    await apply({
      type: "chain-pruned",
      block: await idOf(b3),
      checkpointed: await tipOf(b3, 3),
      proven: await tipOf(b2, 2),
    });
    const afterPrune = await view(postgres);
    const memoryAfterPrune = await view(memory);
    expect(afterPrune).toEqual(memoryAfterPrune);
    expect(afterPrune.tips.proposed.number).toBe(3);
    expect(afterPrune.tips.checkpointed.block.number).toBe(3);
    expect(afterPrune.tips.proven.block.number).toBe(2);
    // The prune kept the hashes above its target.
    expect(
      await Promise.all(
        [5, 6].map((height) => postgres.holdsHashAtOrAbove(height)),
      ),
    ).toEqual(
      [5, 6].map((height) =>
        memoryAfterPrune.hashes
          .slice(height)
          .some((hash) => hash !== undefined),
      ),
    );

    await apply({ type: "blocks-added", blocks: replacing });
    await apply({
      type: "chain-proposed",
      block: await idOf(replacing[2]),
      header: replacing[2].header,
    });
    const afterReplace = await view(postgres);
    expect(afterReplace).toEqual(await view(memory));
    expect(afterReplace.hashes[4]).toBe((await idOf(replacing[0])).hash);

    const nextVersion = new PostgresL2TipsStore(VERSION + 1, genesis);
    expect(await nextVersion.otherVersionStored()).toBe(true);
    expect(await view(nextVersion)).toEqual(
      await view(new L2TipsMemoryStore(genesis)),
    );
    expect(await view(new PostgresL2TipsStore(VERSION, genesis))).toEqual(
      afterReplace,
    );
  });

  it("joins an enclosing transaction, so a later failure keeps none of its writes", async () => {
    const genesis = await (await L2Block.random(BlockNumber(0))).hash();
    const store = new PostgresL2TipsStore(VERSION + 2, genesis);
    const blocks = await randomChain(1, 2);

    await expect(
      store.runInTransaction(async () => {
        await store.handleBlockStreamEvent({ type: "blocks-added", blocks });
        throw new Error("injected");
      }),
    ).rejects.toThrow("injected");

    expect(await view(store)).toEqual(
      await view(new L2TipsMemoryStore(genesis)),
    );
  });
});
