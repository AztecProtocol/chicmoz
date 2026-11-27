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
 *   hour, until stopped. A height where the API and the node agree on a
 *   hash other than the one they last agreed on, both in samples that are
 *   not blind, is reported as a witnessed prune.
 *
 * Each check prints one JSON line; a one-shot check exits 1 when it finds a
 * mismatch. COMPARE_API_URL is a base URL without a query; each request to
 * either side gives up after COMPARE_TIMEOUT_MS (15 s). The URLs can hold
 * credentials: they are read from the environment and never printed. A
 * failed node call prints only its operation and its HTTP status or timeout,
 * and every line is printed with the URLs' parts redacted.
 */
import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { jsonStringify } from "@aztec-labs/foundation/json-rpc";
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
    COMPARE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  .safeParse(process.env);
if (!env.success) {
  process.stderr.write(
    "compare-chain: set COMPARE_NODE_URL (an Aztec node's JSON-RPC) and COMPARE_API_URL (the explorer API's base URL); COMPARE_TIMEOUT_MS, if set, is a positive integer\n",
  );
  process.exit(2);
}
const {
  COMPARE_NODE_URL: nodeUrl,
  COMPARE_API_URL: apiUrl,
  COMPARE_TIMEOUT_MS: timeoutMs,
} = env.data;

const decoded = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

// Below this, a path segment, query value or fragment is redacted only as part
// of its URL, so a segment like `v1` does not blank every line.
const MIN_PART = 8;

// A server can echo any one part of a URL alone, even inside a valid answer
// (a hex key as a block hash), so each part is redacted on its own, raw and
// decoded, besides the whole URL; the host and the hostname too, since an
// error can name either.
const partsOf = (u: string) => {
  const url = new URL(u);
  const { href, host, hostname, pathname, search, hash, username, password } =
    url;
  const pieces = [
    ...pathname.split("/"),
    ...search
      .slice(1)
      .split("&")
      .map((p) => p.slice(p.indexOf("=") + 1)),
    ...url.searchParams.values(),
    hash,
    hash.slice(1),
  ]
    .flatMap((p) => [p, decoded(p)])
    .filter((p) => p.length >= MIN_PART);
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
    ...pieces,
  ];
};
const secrets = [
  ...new Set(
    [nodeUrl, apiUrl]
      .flatMap(partsOf)
      // As it reads inside a printed JSON string.
      .flatMap((s) => [s, JSON.stringify(s).slice(1, -1)])
      .filter((s) => s.length > 0),
  ),
].sort((a, b) => b.length - a.length);
// Blind to case: hashes are printed in lowercase.
const secretPattern = new RegExp(
  secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi",
);
const redact = (text: string) => text.replace(secretPattern, "<redacted>");

const print = (line: Record<string, unknown>) =>
  process.stdout.write(
    `${redact(JSON.stringify({ at: new Date().toISOString(), ...line }))}\n`,
  );

const timedOut = (e: unknown) => (e as Error).name === "TimeoutError";

/**
 * The SDK client's transport, with a deadline its own fetch has no way to
 * set, and one attempt per read: a check reports a failed read, and `watch`
 * reads again on its next round. Its errors are fixed text.
 */
const nodeFetch = async (
  host: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) => {
  let res: Response;
  try {
    res = await fetch(host, {
      method: "POST",
      body: jsonStringify(body),
      headers: { "content-type": "application/json", ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(timedOut(e) ? "timed out" : "request failed");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  try {
    return { response: (await res.json()) as unknown, headers: res.headers };
  } catch (e) {
    throw new Error(timedOut(e) ? "timed out" : "not JSON");
  }
};

// The SDK's client logs a failed request with the node's full URL.
setLogLevel("silent");
const node = createAztecNodeClient(nodeUrl, { fetch: nodeFetch });

const NODE_FAILURE = /^(HTTP \d{3}|timed out)$/;

/**
 * A node error can carry the server's own message, which can echo a key;
 * only the operation and a status or a timeout leave.
 */
const nodeCall = async <T>(operation: string, call: () => Promise<T>) => {
  try {
    return await call();
  } catch (e) {
    const detail = NODE_FAILURE.exec((e as Error).message)?.[1];
    throw new Error(`node ${operation} failed${detail ? `: ${detail}` : ""}`);
  }
};

const api = async (path: string): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetch(`${apiUrl.replace(/\/+$/, "")}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // fetch's message can quote the URL.
    throw new Error(
      `API ${path}: ${timedOut(e) ? "timed out" : "request failed"}`,
    );
  }
  if (!res.ok) {
    throw new Error(`API ${path}: HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as unknown;
  } catch (e) {
    throw new Error(`API ${path}: ${timedOut(e) ? "timed out" : "not JSON"}`);
  }
};

/** A parse error can quote what the API sent, which can echo a key. */
const apiParsed = async <T>(
  path: string,
  schema: z.ZodType<T, unknown>,
): Promise<T> => {
  const body = await api(path);
  try {
    return schema.parse(body);
  } catch {
    throw new Error(`API ${path}: invalid response`);
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
    const blocks = await apiParsed(
      `/l2/blocks?from=${start}&to=${end}`,
      z.array(chicmozL2BlockLightSchema),
    );
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

const latestApiHeight = () => apiParsed("/l2/latest-height", z.number().int());

const sample = async () => {
  const top = await latestApiHeight();
  return compare(Math.max(1, top - SAMPLE_HEIGHTS + 1), top);
};

const windowCheck = async () => {
  const tips = tipsView(await chainTips());
  return compare(Math.max(1, tips.finalized), tips.proposed, WINDOW_GAP_MS);
};

const reorgs = async () => {
  const records = await apiParsed("/l2/reorgs", z.array(chicmozReorgSchema));
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
  // A failed check is reported and skips only itself.
  const attempt = async (check: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      print({ check, error: (e as Error).message });
    }
  };
  // Per height, the hash the API and the node last agreed on.
  const agreed = new Map<number, string>();
  let lastReorgs = 0;
  let lastWindow = 0;
  while (!stopped) {
    const started = Date.now();
    await attempt("sample", async () => {
      const s = await sample();
      report("sample", s);
      if (s.blind) {
        return;
      }
      for (let height = s.from; height <= s.to; height++) {
        const onApi = s.fromApi.get(height) ?? [];
        const onNode = s.fromNode.get(height);
        if (onNode === undefined || onApi.length !== 1 || onApi[0] !== onNode) {
          continue;
        }
        const before = agreed.get(height);
        if (before !== undefined && before !== onNode) {
          print({ check: "prune-witnessed", height, before, after: onNode });
        }
        agreed.set(height, onNode);
      }
    });
    if (started - lastReorgs >= 10 * MINUTE) {
      lastReorgs = started;
      await attempt("reorgs", reorgs);
    }
    if (started - lastWindow >= 60 * MINUTE) {
      lastWindow = started;
      await attempt("window", async () =>
        report("window", await windowCheck()),
      );
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
