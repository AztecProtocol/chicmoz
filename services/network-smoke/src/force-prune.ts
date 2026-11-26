import { setTimeout as sleep } from "node:timers/promises";
import { RollupAbi } from "@aztec-foundation/l1-artifacts";
import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { type AztecNode } from "@aztec-labs/aztec.js/node";
import { RollupCheatCodes } from "@aztec-labs/ethereum/test";
import { EpochNumber } from "@aztec-labs/foundation/branded-types";
import { DateProvider } from "@aztec-labs/foundation/timer";
import { createAztecNodeDebugClient } from "@aztec-labs/stdlib/interfaces/client";
import { createPublicClient, http } from "viem";

// MAX_RPC_BLOCKS_LEN (stdlib interfaces/api_limit.ts).
const NODE_PAGE = 50;

type NodeTips = Awaited<ReturnType<AztecNode["getChainTips"]>>;

export type TipsView = {
  proposed: number;
  checkpointed: number;
  proven: number;
  finalized: number;
};

const tipsView = (t: NodeTips): TipsView => ({
  proposed: Number(t.proposed.number),
  checkpointed: Number(t.checkpointed.block.number),
  proven: Number(t.proven.block.number),
  finalized: Number(t.finalized.block.number),
});

/** The hash at each height `from`..`to`, as the node serves them now. */
export const readHashes = async (node: AztecNode, to: number, from = 1) => {
  const hashes = new Map<number, string>();
  for (let start = from; start <= to; start += NODE_PAGE) {
    const blocks = await node.getBlocks(
      BlockNumber(start),
      Math.min(NODE_PAGE, to - start + 1),
    );
    for (const b of blocks) {
      hashes.set(Number(b.number), b.hash.toString().toLowerCase());
    }
  }
  return hashes;
};

/** The node's hash at each height up to its proposed tip. */
export const readNodeChain = async (node: AztecNode) =>
  readHashes(node, tipsView(await node.getChainTips()).proposed);

export type ChainEvent = {
  at: number;
  kind: "tip-back" | "height-removed" | "hash-changed";
  height?: number;
  newHash?: string;
};

export type ChainWatch = ReturnType<typeof watchChain>;

/**
 * Polls the node's tips and every hash up to its proposed tip, and records
 * the tip moving back and any height whose block disappears or changes.
 */
export const watchChain = (
  node: AztecNode,
  log: (line: string) => void,
  intervalMs = 1_000,
) => {
  const events: ChainEvent[] = [];
  let hashes = new Map<number, string>();
  let tip: number | undefined;
  let stopped = false;
  const record = (event: ChainEvent) => {
    events.push(event);
    log(`chain ${JSON.stringify(event)}`);
  };
  const poll = async () => {
    const next = tipsView(await node.getChainTips()).proposed;
    const nextHashes = await readHashes(node, next);
    // After the reads, so an event is never dated before what it saw.
    const at = Date.now();
    if (tip !== undefined && next < tip) {
      record({ at, kind: "tip-back" });
    }
    for (const [height, hash] of hashes) {
      const now = nextHashes.get(height);
      if (now === undefined) {
        record({ at, kind: "height-removed", height });
      } else if (now !== hash) {
        record({ at, kind: "hash-changed", height, newHash: now });
      }
    }
    hashes = nextHashes;
    tip = next;
  };
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        await poll();
      } catch (e) {
        log(`chain watch: ${(e as Error).message}`);
      }
      await sleep(Math.max(0, intervalMs - (Date.now() - started)));
    }
  })();
  return {
    events,
    /** Hashes may later change at a height `removed` here: compare with a fresh read. */
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
};

const rollupOf = async (node: AztecNode, anvilUrl: string) => {
  const { rollupAddress } = await node.getL1ContractAddresses();
  const address = rollupAddress.toString();
  const l1 = createPublicClient({
    transport: http(anvilUrl, { timeout: 10_000 }),
  });
  const read = <T>(functionName: string, args: unknown[] = []) =>
    l1.readContract({
      address,
      abi: RollupAbi,
      functionName,
      args,
    } as never) as Promise<T>;
  return {
    cheat: RollupCheatCodes.create(
      [anvilUrl],
      { rollupAddress },
      new DateProvider(),
    ),
    tips: async () => {
      const t = await read<{ pending: bigint; proven: bigint }>("getTips");
      return { pending: Number(t.pending), proven: Number(t.proven) };
    },
    epochOfCheckpoint: async (checkpoint: number) =>
      Number(await read<bigint>("getEpochForCheckpoint", [BigInt(checkpoint)])),
    proofSubmissionEpochs: async () =>
      Number(await read<bigint>("getProofSubmissionEpochs")),
  };
};

export type ForcedPrune = {
  /** The proven tip the node prunes back to. */
  target: number;
  /** Heights built for the prune, all unproven at the warp. */
  doomed: number[];
  /** The node's hashes up to its tip just before the warp. */
  before: Map<number, string>;
  /** Doomed heights the node no longer serves with their old hash. */
  removed: number[];
  /** The node's hashes after the prune, or after the replacement when expected. */
  after: Map<number, string>;
  timings: { triggerToPruneMs: number; pruneToReplacementMs?: number };
  /** Epoch ms: the warp's start, and the first reads, 250 ms apart, that showed the prune and the replacement. */
  at: { warp: number; prune: number; replacement?: number };
};

/**
 * Has the local network prune blocks: proves every checkpoint, builds the
 * doomed blocks (`sendTxs`, then `emptyBlocks` empty ones), and warps L1 past
 * their epoch's proof window, after which the node's archiver removes them.
 * Needs the local network with epoch auto-settle off, or nothing stays
 * unproven. With txs in the doomed blocks the node builds a replacement at
 * once; with none it waits on the shorter chain.
 */
export const forceEpochPrune = async ({
  node,
  nodeUrl,
  anvilUrl,
  sendTxs,
  emptyBlocks,
  afterProve,
  beforeTrigger,
  expectReplacement,
  log,
  timeoutMs = 60_000,
}: {
  node: AztecNode;
  nodeUrl: string;
  anvilUrl: string;
  /** Resolves once the node has the txs in blocks. */
  sendTxs: () => Promise<void>;
  emptyBlocks: number;
  /** Runs once the base is proven, before any doomed block is built. */
  afterProve: (base: Map<number, string>) => Promise<void>;
  /** Runs with the doomed blocks built, before the warp. */
  beforeTrigger: (
    doomed: number[],
    hashes: Map<number, string>,
  ) => Promise<void>;
  expectReplacement: boolean;
  log: (line: string) => void;
  timeoutMs?: number;
}): Promise<ForcedPrune> => {
  // The local network serves its debug namespace on the public port. With
  // auto-settle off, `prove` is the only way the proven tip moves.
  const debug = createAztecNodeDebugClient(nodeUrl);
  const rollup = await rollupOf(node, anvilUrl);
  const provenTo = await debug.prove();
  log(`proved to checkpoint ${provenTo}`);
  // One block per checkpoint on the local network.
  await afterProve(await readHashes(node, Number(provenTo)));

  await sendTxs();
  for (let i = 0; i < emptyBlocks; i++) {
    await debug.mineBlock();
  }
  // The automine publishes before it returns; one archiver pass (500 ms)
  // then moves the checkpointed tip.
  await sleep(1_500);
  const tips = tipsView(await node.getChainTips());
  const before = await readHashes(node, tips.proposed);
  const doomed = [...before.keys()].filter((h) => h > tips.proven);
  const l1 = await rollup.tips();
  if (doomed.length === 0 || l1.pending === l1.proven) {
    throw new Error(
      `nothing unproven to prune (tips ${JSON.stringify(tips)}, L1 ${JSON.stringify(l1)}): is epoch auto-settle off?`,
    );
  }
  await beforeTrigger(doomed, before);

  const epoch = await rollup.epochOfCheckpoint(l1.proven + 1);
  const targetEpoch = epoch + (await rollup.proofSubmissionEpochs()) + 1;
  const warpedAt = Date.now();
  await rollup.cheat.advanceToEpoch(EpochNumber(targetEpoch));
  log(
    `doomed ${doomed.join(",")}; warped from epoch ${epoch} to ${targetEpoch}`,
  );

  // Each read is compared with `before`, not with the previous read: a
  // height read absent and later holding a new block differs from neither
  // neighbouring read.
  const doomedTip = Math.max(...doomed);
  let pruneAt: number | undefined;
  let replacedAt: number | undefined;
  while (Date.now() < warpedAt + timeoutMs) {
    const tip = tipsView(await node.getChainTips()).proposed;
    const now = await readHashes(node, Math.min(tip, doomedTip), doomed[0]);
    const at = Date.now();
    const moved = doomed.filter((h) => now.get(h) !== before.get(h));
    if (moved.length > 0) {
      pruneAt ??= at;
    }
    if (moved.some((h) => now.has(h))) {
      replacedAt ??= at;
    }
    if (
      pruneAt !== undefined &&
      (!expectReplacement || replacedAt !== undefined)
    ) {
      break;
    }
    await sleep(250);
  }
  if (pruneAt === undefined) {
    throw new Error(
      `no prune of ${doomed.join(",")} within ${timeoutMs / 1000} s of the warp`,
    );
  }
  if (expectReplacement && replacedAt === undefined) {
    throw new Error(
      `no replacement block within ${timeoutMs / 1000} s of the warp`,
    );
  }
  const after = await readNodeChain(node);
  return {
    target: tips.proven,
    doomed,
    before,
    removed: doomed.filter((h) => after.get(h) !== before.get(h)),
    after,
    timings: {
      triggerToPruneMs: pruneAt - warpedAt,
      pruneToReplacementMs:
        replacedAt === undefined ? undefined : replacedAt - pruneAt,
    },
    at: { warp: warpedAt, prune: pruneAt, replacement: replacedAt },
  };
};
