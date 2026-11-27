import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type BuiltBlock,
  buildBlock,
  freshTxHash,
  orderedEvent,
} from "./support/blocks.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

type ChainRevision = typeof import("../../src/svcs/cache/chain-revision.js");

const crash = vi.hoisted(() => ({ beforeBump: false }));

// A crash right after a block's commit: the block is stored, and nothing
// after the commit runs.
vi.mock("../../src/svcs/cache/chain-revision.js", async (importOriginal) => {
  const actual = await importOriginal<ChainRevision>();
  return {
    ...actual,
    bumpChainRevision: () =>
      crash.beforeBump
        ? Promise.reject(new Error("crashed before the bump"))
        : actual.bumpChainRevision(),
  };
});

describe("explorer-api start-up on a real database and Redis", () => {
  let api: ExplorerApiForTest;
  let store: (b: BuiltBlock) => Promise<void>;

  beforeAll(async () => {
    // Archive mode starts without consuming or reconciling.
    vi.stubEnv("ARCHIVE_MODE", "true");
    api = await startExplorerApiForTest();
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    store = (b) => deliver(blockHandler, orderedEvent(b));
  });

  afterAll(async () => {
    await api?.close();
    vi.unstubAllEnvs();
  });

  it("serves the block that replaced a cached one once it starts, after a crash cut off that block's bump", async () => {
    const atHeight = async () => {
      const res = await api.request.get("/l2/blocks/2");
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      return (res.body as { hash: HexString }).hash;
    };
    const parent = await buildBlock(1n, [freshTxHash()]);
    const replaced = await buildBlock(2n, [freshTxHash()], { parent });
    const replacing = await buildBlock(2n, [freshTxHash()], { parent });
    await store(parent);
    await store(replaced);
    expect(await atHeight()).toBe(replaced.hash);

    crash.beforeBump = true;
    await expect(store(replacing)).rejects.toThrow("crashed before the bump");
    crash.beforeBump = false;
    expect(await atHeight()).toBe(replaced.hash);

    const { start } = await import("../../src/start.js");
    await start();

    expect(await atHeight()).toBe(replacing.hash);
  });
});
