import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
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

const sortedByRoot = (records: ReorgRecord[]) =>
  [...records].sort(
    (a, b) =>
      a.height - b.height ||
      a.orphanedBlockHash.localeCompare(b.orphanedBlockHash),
  );

/** Sorted by root, so two lists compare as sets; a failed read stays as it is. */
export const byRoot = (reorgs: ReorgList): ReorgList =>
  Array.isArray(reorgs) ? sortedByRoot(reorgs) : reorgs;

/** `baseline` with `record` added, by root. */
export const plusReorg = (baseline: ReorgRecord[], record: ReorgRecord) =>
  sortedByRoot([...baseline, record]);

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
  const reorgs = () =>
    read("/l2/reorgs", (body) =>
      z
        .array(chicmozReorgSchema)
        .parse(body)
        .map((r) => ({
          height: Number(r.height),
          nbrOfOrphanedBlocks: r.nbrOfOrphanedBlocks,
          orphanedBlockHash: r.orphanedBlockHash.toLowerCase(),
        })),
    );
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
    reorgs,
    /** The list, or a throw: a baseline that later reads are compared with cannot be a failed read. */
    reorgList: async (): Promise<ReorgRecord[]> => {
      const list = await reorgs();
      if (!Array.isArray(list)) {
        throw new Error(`/l2/reorgs answered ${list.status}`);
      }
      return list;
    },
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

/** Whether `value` holds `want`'s value at each of `want`'s keys. */
export const holds = <T extends object>(value: T, want: Partial<T>) =>
  Object.entries(want).every(([key, expected]) =>
    isDeepStrictEqual(value[key as keyof T], expected),
  );

/**
 * Reads `snapshot` until it `holds` `want` or `timeoutMs` passes, then waits
 * until the API has committed through the end offsets of its topics at that
 * moment (`consumedThrough`), and reads it once more after `cacheMs`, when
 * the API's REST cache holds nothing older: that read is the settled state,
 * whether `want` was met or not. Waiting on `want` keeps a fast read from
 * settling before the listener publishes; offsets taken once keep records
 * that never stop, tips and node liveness, from holding it off.
 */
export const settle = async <T extends object>(
  snapshot: () => Promise<T>,
  {
    want,
    timeoutMs,
    intervalMs,
    cacheMs,
    consumedThrough,
  }: {
    want: Partial<T>;
    timeoutMs: number;
    intervalMs: number;
    cacheMs: number;
    consumedThrough: (timeoutMs: number) => Promise<void>;
  },
) => {
  const deadline = Date.now() + timeoutMs;
  let value = await snapshot();
  while (!holds(value, want) && Date.now() < deadline) {
    await sleep(intervalMs);
    value = await snapshot();
  }
  const met = holds(value, want);
  await consumedThrough(timeoutMs);
  await sleep(cacheMs);
  const confirmed = await snapshot();
  return { value: confirmed, met, held: holds(confirmed, want) };
};
