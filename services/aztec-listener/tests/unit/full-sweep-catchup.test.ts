import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Environment from "../../src/environment.js";
import { type StreamChain } from "../../src/svcs/poller/pollers/block_poller/index.js";

describe("full-sweep catchup config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults full-sweep catchup off", async () => {
    delete process.env.AZTEC_ENABLE_FULL_SWEEP_CATCHUP;

    const { AZTEC_ENABLE_FULL_SWEEP_CATCHUP } = await import(
      "../../src/environment.js"
    );

    expect(AZTEC_ENABLE_FULL_SWEEP_CATCHUP).toBe(false);
  });

  it("enables full-sweep catchup with the new explicit env var", async () => {
    process.env.AZTEC_ENABLE_FULL_SWEEP_CATCHUP = "true";

    const { AZTEC_ENABLE_FULL_SWEEP_CATCHUP } = await import(
      "../../src/environment.js"
    );

    expect(AZTEC_ENABLE_FULL_SWEEP_CATCHUP).toBe(true);
  });
});

describe("block poller full sweep", () => {
  const node = { name: "pool-node", url: "http://pool-node.invalid" };
  const onCatchupBlock = vi.fn();
  const openAttestedReader = vi.fn();
  const storeProcessedProposedBlockHeight = vi.fn();

  const importPoller = async (fullSweepEnabled: boolean) => {
    vi.resetModules();
    vi.doMock("../../src/environment.js", async (importOriginal) => ({
      ...(await importOriginal<typeof Environment>()),
      AZTEC_ENABLE_FULL_SWEEP_CATCHUP: fullSweepEnabled,
    }));
    vi.doMock("../../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock("../../src/events/emitted/index.js", () => ({
      onCatchupBlock,
      onOrderedBlock: vi.fn(),
    }));
    vi.doMock("../../src/svcs/database/heights.controller.js", () => ({
      getBlockHeights: () =>
        Promise.resolve({ processedProposedBlockHeight: 3 }),
      storeProcessedProposedBlockHeight,
    }));
    vi.doMock("../../src/svcs/poller/network-client/attested-reads.js", () => ({
      openAttestedReader,
    }));
    vi.doMock("../../src/svcs/poller/network-client/pool.js", () => ({
      getOnlineRpcNodes: () => [node],
      getRpcNode: () => node,
    }));
    return import("../../src/svcs/poller/pollers/block_poller/index.js");
  };

  // No node is eligible, so the pass reads nothing; the store's tip runs from `tips`.
  const idleChain = (...tips: number[]) =>
    ({
      rollupVersion: 7,
      store: {
        getL2Tips: () =>
          Promise.resolve({ proposed: { number: tips.shift() ?? 3 } }),
        holdsHashAtOrAbove: () => Promise.resolve(true),
      },
      source: { elect: () => Promise.resolve(undefined) },
      publisher: {},
    }) as unknown as StreamChain;

  beforeEach(() => {
    vi.clearAllMocks();
    // The node reader attests block 1 only.
    openAttestedReader.mockResolvedValue({
      getBlock: (height: number) =>
        Promise.resolve({ block: { height }, final: height === 1 }),
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("sweeps nothing when disabled", async () => {
    const { runPass } = await importPoller(false);

    await runPass(idleChain());

    expect(openAttestedReader).not.toHaveBeenCalled();
    expect(onCatchupBlock).not.toHaveBeenCalled();
  });

  it("sweeps one block per pass that leaves the tip, below the store's tip, marking final what the node's reader attests", async () => {
    const { runPass } = await importPoller(true);

    for (let pass = 0; pass < 3; pass++) {
      await runPass(idleChain());
    }
    await runPass(idleChain(3, 4));

    expect(openAttestedReader).toHaveBeenCalledTimes(3);
    expect(openAttestedReader).toHaveBeenCalledWith(node, 7);
    expect(onCatchupBlock.mock.calls).toEqual([
      [{ height: 1 }, "proposed", { final: true }],
      [{ height: 2 }, "proposed", {}],
      [{ height: 1 }, "proposed", { final: true }],
    ]);
    expect(storeProcessedProposedBlockHeight).toHaveBeenCalledWith(4);
  });
});
