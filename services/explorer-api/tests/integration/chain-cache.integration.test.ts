import { type HexString } from "@chicmoz-pkg/types";
import { deliver } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuiltBlock,
  buildBlock,
  freshTxHash,
  orderedEvent,
} from "./support/blocks.js";
import { loadChainReads } from "./support/chain.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";

type Holder = { blockHash: HexString; isOrphaned: boolean };

describe("cached chain reads on a real database and Redis", () => {
  let api: ExplorerApiForTest;
  let store: (b: BuiltBlock) => Promise<void>;
  let reads: Awaited<ReturnType<typeof loadChainReads>>;

  const body = async <T>(path: string): Promise<T> => {
    const res = await api.request.get(path);
    expect(res.status, `GET ${path}: ${res.text.slice(0, 300)}`).toBe(200);
    return res.body as T;
  };
  const holder = ({ blockHash, isOrphaned }: Holder) => [blockHash, isOrphaned];

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { blockHandler } = await import(
      "../../src/events/received/on-block/index.js"
    );
    reads = await loadChainReads();
    store = (b) => deliver(blockHandler, orderedEvent(b));
  });

  afterAll(async () => {
    await api?.close();
  });

  // The prune leaves the tip's height, and so the latest height in the
  // latest-block keys, as it was.
  it("serves the block that replaced the tip, and the tx and instance it took, from a warm cache", async () => {
    const parent = await buildBlock(1n, [freshTxHash()], {
      effect: "publishesClass",
    });
    const deployTx = freshTxHash();
    const atTip = () =>
      buildBlock(2n, [deployTx], { parent, effect: "deploysInstance" });
    const replaced = await atTip();
    const replacing = await atTip();
    await store(parent);
    await store(replaced);
    const [address] = await reads.instancesOf(replaced.hash);
    const served = async () => ({
      latest: (await body<{ hash: HexString }>("/l2/blocks/latest")).hash,
      atHeight: (await body<{ hash: HexString }>("/l2/blocks/2")).hash,
      replacedOnChain: !(
        await body<{ orphan?: unknown }>(`/l2/blocks/${replaced.hash}`)
      ).orphan,
      txEffectsAtHeight: (await body<Holder[]>("/l2/blocks/2/tx-effects")).map(
        holder,
      ),
      txEffectAtIndex: holder(await body<Holder>("/l2/blocks/2/tx-effects/0")),
      txEffect: holder(await body<Holder>(`/l2/tx-effects/${deployTx}`)),
      instance: holder(await body<Holder>(`/l2/contract-instances/${address}`)),
      instancesOfReplaced: (
        await body<{ address: HexString }[]>(
          `/l2/blocks/${replaced.hash}/contract-instances`,
        )
      ).map((i) => i.address),
    });
    const servedWith = (tip: BuiltBlock) => ({
      latest: tip.hash,
      atHeight: tip.hash,
      replacedOnChain: tip === replaced,
      txEffectsAtHeight: [[tip.hash, false]],
      txEffectAtIndex: [tip.hash, false],
      txEffect: [tip.hash, false],
      instance: [tip.hash, false],
      instancesOfReplaced: tip === replaced ? [address] : [],
    });
    expect(await served()).toEqual(servedWith(replaced));

    await store(replacing);

    expect(await served()).toEqual(servedWith(replacing));
  });
});
