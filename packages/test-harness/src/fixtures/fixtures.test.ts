import { BSON } from "bson";
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { frameLeaks } from "./frame.js";
import {
  FIXTURE_KINDS,
  FIXTURE_NAME,
  FIXTURE_SOURCES,
  fromTagged,
  toTagged,
  type Fixture,
  type FixtureKind,
  type FixtureSource,
} from "./format.js";
import { FIXTURES_DIR, frameBytes, listFixtures, loadFixture, readFixtureFile } from "./index.js";
import { findLeaks, sanitize } from "./sanitize.js";

// The corpus other suites build on; a re-record that loses one of these fails here, not in them.
const REQUIRED: Record<FixtureSource, Partial<Record<FixtureKind, string[]>>> = {
  "local-network": {
    "l2-block": ["block-1", "block-2", "block-11"],
    "node-info": ["node-info"],
    "l2-tips": ["l2-tips"],
    frame: ["chain-info-event-1", "l2-tips-event-1", "pending-txs-event-1"],
    "api-body": [
      "block-by-height",
      "chain-info",
      "contract-class-versions",
      "contract-instance",
      "fee-recipients",
      "governance-proposals",
      "l1-contract-events",
      "l2-validator-totals",
      "pending-txs",
      "public-call-requests-by-tx",
      "rpc-nodes",
      "search-by-height",
      "tips",
      "total-tx-effects",
      "tx-effect-by-hash",
    ],
  },
  testnet: {
    "l2-block": ["block-46972", "block-46973", "block-46974", "block-46975", "block-46976", "block-46977"],
    checkpoint: ["checkpoint-33600"],
    "node-info": ["node-info"],
    "l2-tips": ["l2-tips"],
    "l1-log": [
      "checkpoint-proposed-33600",
      "proof-verified-33608",
      "deposit-to-aztec-public",
      "governance-proposed",
      "governance-vote-cast",
      "rollup-validator-queued",
    ],
  },
};
// What the parseBlock test needs the blocks to contain, read from the node's values rather than the
// feature labels. No recorded block carries an L2-to-L1 message: neither source sends one on demand.
type Expected = Fixture<"l2-block">["data"]["expected"];
const BLOCK_CONTENT_NEEDED: Record<string, (e: Expected) => boolean> = {
  "an empty block": (e) => e.counts.txEffects === 0,
  "a class publication": (e) => e.contractClassIds.length > 0,
  "an instance deployment": (e) => e.contractInstanceAddresses.length > 0,
};
const BLOCK_COUNTS_NEEDED = ["noteHashes", "nullifiers", "publicDataWrites", "publicLogs", "privateLogs", "contractClassLogs"] as const;

const corpus = () =>
  readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f !== "README.md" && statSync(join(FIXTURES_DIR, f)).isFile())
    .map((f) => {
      const [source, kind, file, ...rest] = f.split(sep);
      const placed =
        rest.length === 0 &&
        FIXTURE_NAME.test(file?.slice(0, -".json".length) ?? "") &&
        FIXTURE_SOURCES.includes(source as FixtureSource) &&
        FIXTURE_KINDS.includes(kind as FixtureKind) &&
        file?.endsWith(".json");
      return { path: f, placed, source: source as FixtureSource, kind: kind as FixtureKind, name: file?.slice(0, -".json".length) ?? "" };
    });

describe("committed fixtures", () => {
  it("are all placed as <source>/<kind>/<name>.json and load from where they sit", () => {
    const files = corpus();
    expect(files.filter((f) => !f.placed).map((f) => f.path)).toEqual([]);
    for (const f of files) {
      expect(loadFixture(f.source, f.kind, f.name).kind).toBe(f.kind);
    }
  });

  // Fixtures are public: a re-record must not publish an operator's address,
  // an ENR (it encodes one), a private host, a local path or a key, also not inside a frame's bytes.
  it("hold no address, ENR, private URL, local path or key", () => {
    const leaks = corpus().flatMap((f) => {
      const frame =
        f.kind === "frame" ? frameLeaks(frameBytes(loadFixture(f.source, "frame", f.name)), "$bson") : [];
      return [...findLeaks(readFixtureFile(join(FIXTURES_DIR, f.path))), ...frame].map(
        (l) => `${f.path} ${l.path}: ${l.reason}`,
      );
    });
    expect(leaks).toEqual([]);
  });

  it("include every fixture other suites require", () => {
    const present = new Set(corpus().map((f) => `${f.source}/${f.kind}/${f.name}`));
    const required = FIXTURE_SOURCES.flatMap((source) =>
      Object.entries(REQUIRED[source]).flatMap(([kind, names]) => names.map((n) => `${source}/${kind}/${n}`)),
    );
    expect(required.filter((r) => !present.has(r))).toEqual([]);
  });

  it("give the block decoder every feature and log kind to check", () => {
    const blocks = FIXTURE_SOURCES.flatMap((source) =>
      listFixtures(source, "l2-block").map((name) => loadFixture(source, "l2-block", name)),
    );
    const recorded = blocks.filter((b) => !b.features.includes("synthetic"));
    const missing = Object.entries(BLOCK_CONTENT_NEEDED).filter(([, has]) => !recorded.some((b) => has(b.data.expected)));
    expect(missing.map(([what]) => what)).toEqual([]);
    const empty = BLOCK_COUNTS_NEEDED.filter((k) => recorded.every((b) => b.data.expected.counts[k] === 0));
    expect(empty).toEqual([]);
  });
});

describe("sanitize", () => {
  it("removes every leak findLeaks reports, and keeps everything else", () => {
    const raw = {
      enr: "enr:-My4QGdIJJ5HL2i7XtQSm3BCypYBZzRh0o7uAO1nW0Bg",
      rpcUrl: "https://node.internal.corp:8080/v1/temporary-api-key/x",
      withCredentials: "http://user:pw@127.0.0.1:8080",
      cause: "connect ECONNREFUSED 10.1.2.3:8080 and 2a01:4f8::7, then 10.4.4.4.",
      apiKey: "abc",
      clientSecret: "abc",
      api_key_value: "abc",
      privatekey: "abc",
      local: "http://127.0.0.1:8080/l2/blocks?from=1",
      localPath: "http://127.0.0.1:8080/l2/blocks",
      lookalike: "http://127.example.net/x",
      secretHash: "0x01",
      noirPath: "use dep::aztec::macros",
      block: { number: 5, hash: "0x2a", timestamp: 1795107396n, at: new Date(0) },
      "10.9.8.7": "a key is data too",
    };
    expect(findLeaks(toTagged(raw)).map((l) => l.path)).toEqual([
      "$.enr",
      "$.rpcUrl",
      "$.rpcUrl",
      "$.rpcUrl",
      "$.withCredentials",
      "$.cause",
      "$.<key 4>",
      "$.<key 5>",
      "$.<key 6>",
      "$.<key 7>",
      "$.local",
      "$.localPath",
      "$.lookalike",
      "$.<key 14> (key)",
    ]);
    const clean = sanitize(raw);
    expect(findLeaks(toTagged(clean))).toEqual([]);
    expect(clean).toEqual({
      enr: "enr:-redacted",
      rpcUrl: "http://rpc.example",
      withCredentials: "http://rpc.example",
      cause: "connect ECONNREFUSED 192.0.2.1:8080 and 2001:db8::1, then 192.0.2.1.",
      local: "http://127.0.0.1:8080",
      localPath: "http://127.0.0.1:8080",
      lookalike: "http://rpc.example",
      secretHash: "0x01",
      noirPath: "use dep::aztec::macros",
      block: { number: 5, hash: "0x2a", timestamp: 1795107396n, at: new Date(0) },
      "192.0.2.1": "a key is data too",
    });
    // Rejected, not rewritten: the recorder refuses to write these.
    const identity = ["worker-7", "worker7"];
    const local = {
      host: "ip-10-0-1-2.eu-west-2.compute.internal",
      node: "worker.internal",
      path: "/home/me/x",
      mine: "worker-7",
      worker7: 1,
      route: "/l2/info?apiKey=x",
      encoded: "/l2/info?%61piKey=x",
      search: "/l2/search?q=11",
    };
    expect(findLeaks(local, "$", identity).map((l) => l.path)).toEqual([
      "$.host",
      "$.node",
      "$.path",
      "$.mine",
      "$.<key 4> (key)",
      "$.route",
      "$.encoded",
    ]);
    const binary = BSON.serialize({ data: { b: new BSON.Binary(new TextEncoder().encode("http://10.0.0.1")) } });
    expect(frameLeaks(binary, "$").map((l) => l.reason)).toEqual(["binary value in a frame"]);
  });

  it("tags round-trip bigint, bytes and dates, and malformed tags throw", () => {
    const value = { a: 2n ** 70n, b: Buffer.from("00ff", "hex"), c: new Date(0), d: [1n] };
    expect(fromTagged(JSON.parse(JSON.stringify(toTagged(value))))).toEqual(value);
    expect(() => fromTagged({ $hex: "abc" })).toThrow();
    expect(() => fromTagged({ $date: "yesterday" })).toThrow();
    expect(() => fromTagged({ $date: "2026-02-31T00:00:00.000Z" })).toThrow();
    expect(() => loadFixture("testnet", "l2-block", "../l2-tips/l2-tips")).toThrow();
    expect(() => fromTagged({ $bigint: "1", extra: 1 })).toThrow();
  });
});
