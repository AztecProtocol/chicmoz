import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FIXTURE_SOURCES, type FixtureSource } from "../fixtures/format.js";
import { recordApiBodies, type ApiRoute } from "./api.js";
import { tapFrames } from "./kafka.js";
import { recordL1Log } from "./l1.js";
import { createLimiter } from "./limiter.js";
import {
  BLOCK_FEATURES,
  recordBlocks,
  recordCheckpoint,
  recordNodeInfo,
  scanBlocks,
  type BlockFeature,
} from "./node.js";

const USAGE = `record-fixtures <target> --source local-network|testnet [options]
  node   --url <aztec rpc> [--info] [--heights 1,2] [--scan 1..40 --want empty,public-logs,class-publish,instance-deploy]
         [--checkpoint <n> [--find-multi-block]]
  l1     --rpc <l1 rpc> --aztec-version <v> --name <fixture> --contract <rollup|feeJuicePortal|...> --address <0x..>
         --event <Name> [--arg key=value] --from <block> --to <block> [--direction forward|backward] [--chunk 1000] [--max-requests 30]
  kafka  --connection 127.0.0.1:<port> --namespace <ns> --network SANDBOX --events PENDING_TXS_EVENT,L2_TIPS_EVENT
         --aztec-version <v> [--max 1] [--timeout-ms 60000]
  api    --base-url http://127.0.0.1:<port> --routes <routes.json> --aztec-version <v>
Requests to non-loopback hosts are spaced by at least 1 s; each is logged to stderr.`;

const log = (line: string) => process.stderr.write(`${line}\n`);

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    url: { type: "string" },
    info: { type: "boolean" },
    heights: { type: "string" },
    scan: { type: "string" },
    want: { type: "string" },
    checkpoint: { type: "string" },
    "find-multi-block": { type: "boolean" },
    rpc: { type: "string" },
    "aztec-version": { type: "string" },
    name: { type: "string" },
    contract: { type: "string" },
    address: { type: "string" },
    event: { type: "string" },
    arg: { type: "string", multiple: true },
    from: { type: "string" },
    to: { type: "string" },
    direction: { type: "string" },
    chunk: { type: "string" },
    "max-requests": { type: "string" },
    connection: { type: "string" },
    namespace: { type: "string" },
    network: { type: "string" },
    events: { type: "string" },
    max: { type: "string" },
    "timeout-ms": { type: "string" },
    "base-url": { type: "string" },
    routes: { type: "string" },
  },
});

const need = (name: keyof typeof v): string => {
  const value = v[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`--${name} is required\n${USAGE}`);
  }
  return value;
};

const checkedUrl = (raw: string): string => {
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error("URLs with credentials are refused");
  }
  return raw;
};

const main = async () => {
  const [target] = positionals;
  const source = need("source") as FixtureSource;
  if (!FIXTURE_SOURCES.includes(source)) {
    throw new Error(`--source must be one of ${FIXTURE_SOURCES.join(", ")}`);
  }
  const limiter = createLimiter(log);

  if (target === "node") {
    const r = { url: checkedUrl(need("url")), source, limiter, log };
    const version = await recordNodeInfo(r);
    if (v.heights) {
      await recordBlocks(r, version, v.heights.split(",").map(Number));
    }
    if (v.scan) {
      const [from, to] = v.scan.split("..").map(Number);
      const want = need("want").split(",") as BlockFeature[];
      if (!want.every((f) => BLOCK_FEATURES.includes(f))) {
        throw new Error(`--want takes ${BLOCK_FEATURES.join(", ")}`);
      }
      const missing = await scanBlocks(r, version, from ?? 1, to ?? 1, want);
      log(missing.length ? `not found: ${missing.join(", ")}` : "found every wanted feature");
    }
    if (v.checkpoint) {
      const n = await recordCheckpoint(r, version, Number(v.checkpoint), v["find-multi-block"] ?? false);
      log(`recorded checkpoint ${n}`);
    }
    return;
  }
  if (target === "l1") {
    const args = Object.fromEntries(
      (v.arg ?? []).map((a) => {
        const [k, val] = a.split("=");
        return [k, /^\d+$/.test(val ?? "") ? BigInt(val ?? 0) : (val ?? "")];
      }),
    );
    await recordL1Log({
      source,
      aztecVersion: need("aztec-version"),
      rpc: checkedUrl(need("rpc")),
      name: need("name"),
      contract: need("contract"),
      address: need("address") as `0x${string}`,
      eventName: need("event"),
      args: Object.keys(args).length > 0 ? args : undefined,
      from: BigInt(need("from")),
      to: BigInt(need("to")),
      direction: v.direction === "forward" ? "forward" : "backward",
      chunk: BigInt(v.chunk ?? "1000"),
      maxRequests: Number(v["max-requests"] ?? "30"),
      limiter,
      log,
    });
    return;
  }
  if (target === "kafka") {
    const counts = await tapFrames({
      source,
      aztecVersion: need("aztec-version"),
      connection: need("connection"),
      namespace: need("namespace"),
      network: need("network"),
      eventTypes: need("events").split(","),
      maxPerEvent: Number(v.max ?? "1"),
      timeoutMs: Number(v["timeout-ms"] ?? "60000"),
      log,
    });
    log(`frames: ${JSON.stringify(counts)}`);
    return;
  }
  if (target === "api") {
    await recordApiBodies({
      source,
      aztecVersion: need("aztec-version"),
      baseUrl: checkedUrl(need("base-url")),
      routes: JSON.parse(readFileSync(need("routes"), "utf8")) as ApiRoute[],
      log,
    });
    return;
  }
  throw new Error(USAGE);
};

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
});
