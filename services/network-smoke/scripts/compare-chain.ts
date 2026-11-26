/**
 * Read-only check that the explorer API's canonical chain is the node's.
 *
 *   COMPARE_NODE_URL=… COMPARE_API_URL=… node scripts/compare-chain.ts <check>
 *
 * - `sample`: the API's top 40 heights, in 20-block calls, against the
 *   node's hashes there. The node's tips are read before and after; the
 *   sample is `blind` if they moved.
 * - `window`: every height from the node's finalized tip to its proposed
 *   tip, one API call every 2 s.
 * - `reorgs`: each `/l2/reorgs` record whose dead root the node still has.
 * - `watch`: `sample` every 60 s, `reorgs` every 10 min and `window` every
 *   hour, until stopped. A height whose API hash and node hash both changed
 *   since its last sample is reported as a witnessed prune.
 *
 * Each check prints one JSON line; a one-shot check exits 1 when it finds a
 * mismatch. COMPARE_API_URL is a base URL without a query. The URLs can hold
 * credentials: they are read from the environment and never printed. A
 * failed node call prints only its operation and HTTP status, and every line
 * is printed with the URLs' parts redacted.
 */
import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { defaultFetch } from "@aztec-labs/foundation/json-rpc/client";
import { setLogLevel } from "@aztec-labs/foundation/log";
import {
  chicmozL2BlockLightSchema,
  chicmozReorgSchema,
} from "@chicmoz-pkg/types";
import { z } from "zod";

const SAMPLE_HEIGHTS = 40;
// The API's widest range (DB_MAX_BLOCKS); `to` is exclusive.
const API_PAGE = 20;
// The node's widest getBlocks (MAX_RPC_BLOCKS_LEN).
const NODE_PAGE = 50;
const WINDOW_GAP_MS = 2_000;
const MINUTE = 60_000;

const env = z
  .object({
    COMPARE_NODE_URL: z.string().url(),
    COMPARE_API_URL: z.string().url(),
  })
  .safeParse(process.env);
if (!env.success) {
  process.stderr.write(
    "compare-chain: set COMPARE_NODE_URL (an Aztec node's JSON-RPC) and COMPARE_API_URL (the explorer API's base URL)\n",
  );
  process.exit(2);
}
const { COMPARE_NODE_URL: nodeUrl, COMPARE_API_URL: apiUrl } = env.data;

const decoded = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

// A base path, a query, a user or a password can carry a key, so each is
// redacted on its own as well as the whole URL; the host and the hostname
// too, since an error can name either.
const secrets = [nodeUrl, apiUrl]
  .flatMap((u) => {
    const { href, host, hostname, pathname, search, username, password } =
      new URL(u);
    return [
      u,
      href,
      host,
      hostname,
      pathname.length > 1 ? pathname : "",
      search,
      username,
      decoded(username),
      password,
      decoded(password),
    ];
  })
  .filter((s) => s.length > 0)
  .sort((a, b) => b.length - a.length);
const redact = (text: string) =>
  secrets.reduce((t, s) => t.split(s).join("<redacted>"), text);

const print = (line: Record<string, unknown>) =>
  process.stdout.write(
    `${redact(JSON.stringify({ at: new Date().toISOString(), ...line }))}\n`,
  );

// The SDK's client logs a failed request with the node's full URL.
setLogLevel("silent");
// One attempt per read: a check reports a failed read, and `watch` reads
// again on its next round.
const node = createAztecNodeClient(nodeUrl, { fetch: defaultFetch });

const HTTP_STATUS = /^Error (\d{3}) from server /;

/**
 * The SDK's message names the host, its cause's hostname and the server's
 * error body, which can echo a key; only the operation and the status leave.
 */
const nodeCall = async <T>(operation: string, call: () => Promise<T>) => {
  try {
    return await call();
  } catch (e) {
    const status = HTTP_STATUS.exec((e as Error).message)?.[1];
    throw new Error(
      `node ${operation} failed${status ? `: HTTP ${status}` : ""}`,
    );
  }
};

const api = async (path: string): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetch(`${apiUrl.replace(/\/+$/, "")}${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // fetch's message can quote the URL.
    throw new Error(`API ${path}: request failed`);
  }
  if (!res.ok) {
    throw new Error(`API ${path}: HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new Error(`API ${path}: not JSON`);
  }
};

type Tips = Awaited<ReturnType<typeof node.getChainTips>>;

const chainTips = () => nodeCall("getChainTips", () => node.getChainTips());

const tipsView = (t: Tips) => ({
  proposed: Number(t.proposed.number),
  checkpointed: Number(t.checkpointed.block.number),
  proven: Number(t.proven.block.number),
  finalized: Number(t.finalized.block.number),
  hashes: [
    t.proposed.hash,
    t.checkpointed.block.hash,
    t.proven.block.hash,
    t.finalized.block.hash,
  ],
});

/** Canonical hashes per height in [from, to], as the API serves them; a height may list two. */
const apiHashes = async (from: number, to: number, gapMs = 0) => {
  const hashes = new Map<number, string[]>();
  for (let start = from; start <= to; start += API_PAGE) {
    if (start > from && gapMs > 0) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
    const end = Math.min(start + API_PAGE, to + 1);
    const blocks = z
      .array(chicmozL2BlockLightSchema)
      .parse(await api(`/l2/blocks?from=${start}&to=${end}`));
    for (const b of blocks) {
      const height = Number(b.height);
      hashes.set(height, [...(hashes.get(height) ?? []), b.hash.toLowerCase()]);
    }
  }
  return hashes;
};

const nodeHashes = async (from: number, to: number) => {
  const hashes = new Map<number, string>();
  for (let start = from; start <= to; start += NODE_PAGE) {
    const blocks = await nodeCall("getBlocks", () =>
      node.getBlocks(BlockNumber(start), Math.min(NODE_PAGE, to - start + 1)),
    );
    for (const b of blocks) {
      hashes.set(Number(b.number), b.hash.toString().toLowerCase());
    }
  }
  return hashes;
};

type Mismatch = { height: number; api: string[]; node: string | null };

const compare = async (from: number, to: number, gapMs = 0) => {
  const before = tipsView(await chainTips());
  const fromApi = await apiHashes(from, to, gapMs);
  const fromNode = await nodeHashes(from, to);
  const after = tipsView(await chainTips());
  const mismatches: Mismatch[] = [];
  for (let height = from; height <= to; height++) {
    const a = fromApi.get(height) ?? [];
    const n = fromNode.get(height) ?? null;
    const agree = a.length === 0 ? n === null : a.length === 1 && a[0] === n;
    if (!agree) {
      mismatches.push({ height, api: a, node: n });
    }
  }
  return {
    from,
    to,
    tips: after,
    blind: JSON.stringify(before) !== JSON.stringify(after),
    mismatches,
    fromApi,
    fromNode,
  };
};

const report = (
  check: string,
  { from, to, tips, blind, mismatches }: Awaited<ReturnType<typeof compare>>,
) => {
  print({
    check,
    from,
    to,
    tips: { ...tips, hashes: undefined },
    blind,
    firstMismatch: mismatches[0] ?? null,
    mismatches: mismatches.length,
  });
  return mismatches.length === 0;
};

const latestApiHeight = async () =>
  z
    .number()
    .int()
    .parse(await api("/l2/latest-height"));

const sample = async () => {
  const top = await latestApiHeight();
  return compare(Math.max(1, top - SAMPLE_HEIGHTS + 1), top);
};

const windowCheck = async () => {
  const tips = tipsView(await chainTips());
  return compare(Math.max(1, tips.finalized), tips.proposed, WINDOW_GAP_MS);
};

const reorgs = async () => {
  const records = z.array(chicmozReorgSchema).parse(await api("/l2/reorgs"));
  const stillOnChain: { height: number; hash: string }[] = [];
  for (const r of records) {
    const height = Number(r.height);
    const hash = r.orphanedBlockHash.toLowerCase();
    if ((await nodeHashes(height, height)).get(height) === hash) {
      stillOnChain.push({ height, hash });
    }
  }
  print({ check: "reorgs", records: records.length, stillOnChain });
  return stillOnChain.length === 0;
};

const watch = async () => {
  let stopped = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => (stopped = true));
  }
  const last = new Map<number, { api: string[]; node: string | null }>();
  let lastReorgs = 0;
  let lastWindow = 0;
  while (!stopped) {
    const started = Date.now();
    try {
      const s = await sample();
      report("sample", s);
      for (let height = s.from; height <= s.to; height++) {
        const now = {
          api: s.fromApi.get(height) ?? [],
          node: s.fromNode.get(height) ?? null,
        };
        const prev = last.get(height);
        if (
          prev &&
          !s.blind &&
          prev.node !== now.node &&
          JSON.stringify(prev.api) !== JSON.stringify(now.api)
        ) {
          print({ check: "prune-witnessed", height, before: prev, after: now });
        }
        last.set(height, now);
      }
      if (started - lastReorgs >= 10 * MINUTE) {
        lastReorgs = started;
        await reorgs();
      }
      if (started - lastWindow >= 60 * MINUTE) {
        lastWindow = started;
        report("window", await windowCheck());
      }
    } catch (e) {
      print({ check: "error", error: (e as Error).message });
    }
    while (!stopped && Date.now() - started < MINUTE) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

const checks: Record<string, () => Promise<boolean>> = {
  sample: async () => report("sample", await sample()),
  window: async () => report("window", await windowCheck()),
  reorgs,
  watch: async () => {
    await watch();
    return true;
  },
};

const check = checks[process.argv[2] ?? ""];
if (!check) {
  process.stderr.write(
    "usage: compare-chain.ts sample | window | reorgs | watch\n",
  );
  process.exit(2);
}
try {
  process.exitCode = (await check()) ? 0 : 1;
} catch (e) {
  print({ check: process.argv[2], error: (e as Error).message });
  process.exitCode = 2;
}
