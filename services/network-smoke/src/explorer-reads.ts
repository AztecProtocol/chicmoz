import { setTimeout as sleep } from "node:timers/promises";
import {
  chicmozL2BlockLightSchema,
  chicmozL2ContractInstanceDeluxeSchema,
  chicmozL2DroppedTxSchema,
  chicmozL2TxEffectDeluxeSchema,
  chicmozReorgSchema,
} from "@chicmoz-pkg/types";
import { z } from "zod";

export type BlockRef = { height: number; hash: string };

export type ReorgRecord = {
  height: number;
  nbrOfOrphanedBlocks: number;
  orphanedBlockHash: string;
};

type ReorgList = ReorgRecord[] | { status: number };

/** Sorted by root, so two lists compare as sets; a failed read stays as it is. */
export const byRoot = (reorgs: ReorgList): ReorgList =>
  Array.isArray(reorgs)
    ? [...reorgs].sort(
        (a, b) =>
          a.height - b.height ||
          a.orphanedBlockHash.localeCompare(b.orphanedBlockHash),
      )
    : reorgs;

/** `baseline` with `record` added, by root; a failed baseline read stays as it is. */
export const plusReorg = (baseline: ReorgList, record: ReorgRecord) =>
  Array.isArray(baseline) ? byRoot([...baseline, record]) : baseline;

/** A block as the scenarios compare it: its id, and whether it is served as orphaned. */
export const served = ({ height, hash }: BlockRef, orphaned: boolean) => ({
  height,
  hash: hash.toLowerCase(),
  orphaned,
});

/** REST reads of an explorer API: the picked body on 200, `{ status }` on any other status. */
export const explorerReads = (apiUrl: string) => {
  const get = async (path: string) => {
    const res = await fetch(new URL(path, apiUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the text itself is the answer.
    }
    return { status: res.status, body };
  };
  const read = async <T>(path: string, pick: (body: unknown) => T) => {
    const { status, body } = await get(path);
    return status === 200 ? pick(body) : { status };
  };
  return {
    get,
    latestHeight: () =>
      read("/l2/latest-height", (body) => z.number().int().parse(body)),
    blockAt: (heightOrHash: number | string) =>
      read(`/l2/blocks/${heightOrHash}`, (body) => {
        const block = chicmozL2BlockLightSchema.parse(body);
        return {
          height: Number(block.height),
          hash: block.hash.toLowerCase(),
          orphaned: block.orphan !== undefined,
        };
      }),
    reorgs: () =>
      read("/l2/reorgs", (body) =>
        z
          .array(chicmozReorgSchema)
          .parse(body)
          .map((r) => ({
            height: Number(r.height),
            nbrOfOrphanedBlocks: r.nbrOfOrphanedBlocks,
            orphanedBlockHash: r.orphanedBlockHash.toLowerCase(),
          })),
      ),
    dropped: (txHash: string) =>
      read(`/l2/dropped-txs/${txHash}`, (body) => {
        const { dropReason } = chicmozL2DroppedTxSchema.parse(body);
        return { status: 200, dropReason };
      }),
    txEffect: (txHash: string) =>
      read(`/l2/tx-effects/${txHash}`, (body) => {
        const effect = chicmozL2TxEffectDeluxeSchema.parse(body);
        return {
          height: Number(effect.blockHeight),
          hash: effect.blockHash.toLowerCase(),
          orphaned: effect.isOrphaned,
        };
      }),
    contractInstance: (address: string) =>
      read(`/l2/contract-instances/${address}`, (body) => {
        const instance = chicmozL2ContractInstanceDeluxeSchema.parse(body);
        return {
          hash: instance.blockHash.toLowerCase(),
          orphaned: instance.isOrphaned,
        };
      }),
  };
};

/**
 * Reads `snapshot` until two reads `gapMs` apart are equal, with `progress`
 * (a counter of the listener's tip reads) grown between them and `consumed`
 * true just before the second, or until `timeoutMs`. Tip reads prove the
 * listener polled, not that the API consumed what it sent: `consumed` covers
 * that. A gap longer than the API's cache keeps two equal reads from being
 * one cache entry read twice.
 */
export const settle = async <T>(
  snapshot: () => Promise<T>,
  {
    gapMs,
    timeoutMs,
    progress,
    consumed,
  }: {
    gapMs: number;
    timeoutMs: number;
    progress?: () => Promise<number> | number;
    consumed?: () => Promise<boolean>;
  },
) => {
  const deadline = Date.now() + timeoutMs;
  let mark = await progress?.();
  let value = await snapshot();
  let settled = false;
  while (!settled && Date.now() < deadline) {
    await sleep(gapMs);
    const caughtUp = (await consumed?.()) ?? true;
    const next = await snapshot();
    const nextMark = await progress?.();
    settled =
      caughtUp &&
      JSON.stringify(next) === JSON.stringify(value) &&
      (mark === undefined || (nextMark ?? 0) > mark);
    value = next;
    mark = nextMark;
  }
  return { value, settled };
};
