import { loadFixture } from "@chicmoz/test-harness";
import { getAddress } from "viem";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { initClient } from "../src/network-client/client/index.js";
import { governanceProposerUpdatedEventCallbacks } from "../src/network-client/contracts/callbacks/index.js";
import { getAllContractsEvents } from "../src/network-client/contracts/get-events.js";
import { getL1Contracts } from "../src/network-client/contracts/index.js";
import { type AztecContracts } from "../src/network-client/contracts/utils.js";
import {
  watchContractEventsGeneric,
  watchGovernanceStructuredEvent,
  watchRollupL2ProofVerified,
} from "../src/network-client/contracts/watch-events.js";

type Range = { fromBlock: bigint; toBlock: bigint | "finalized" };
type Log = { blockNumber: bigint; logIndex: number };
type Row = { latestPendingHeight: bigint; latestFinalizedHeight: bigint };
type EventQuery = { address: string; eventName: string };

const seam = vi.hoisted(() => {
  vi.stubEnv("L2_NETWORK_ID", "TESTNET");
  vi.stubEnv("KAFKA_NAMESPACE", undefined);
  return {
    tip: 0n,
    /** Logs on L1, keyed `<contract address>.<event name>`. */
    chain: new Map<string, Log[]>(),
    reads: [] as ({ stream: string } & Range)[],
    watches: new Map<
      string,
      { fromBlock: bigint; onLogs: (logs: Log[]) => void }
    >(),
    contractReads: {} as Record<string, unknown>,
    /** L1 block number of every event the bus accepted. */
    published: [] as bigint[],
    failPublish: new Set<bigint>(),
    rows: new Map<string, unknown>(),
  };
});

// viem's contract getEvents and watchEvent dispatch to these client actions.
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPublicClient: () => ({
    getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
      Promise.resolve({ timestamp: 1_700_000_000n + blockNumber * 12n }),
    readContract: ({ functionName }: { functionName: string }) =>
      functionName in seam.contractReads
        ? Promise.resolve(seam.contractReads[functionName])
        : Promise.reject(new Error(`no answer for ${functionName}`)),
    getContractEvents: ({
      address,
      eventName,
      fromBlock,
      toBlock,
    }: EventQuery & Range) => {
      const stream = `${address}.${eventName}`;
      seam.reads.push({ stream, fromBlock, toBlock });
      const to = toBlock === "finalized" ? seam.tip : toBlock;
      return Promise.resolve(
        (seam.chain.get(stream) ?? []).filter(
          ({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= to,
        ),
      );
    },
    watchContractEvent: ({
      address,
      eventName,
      fromBlock,
      onLogs,
    }: EventQuery & { fromBlock: bigint; onLogs: (logs: Log[]) => void }) => {
      seam.watches.set(`${address}.${eventName}`, { fromBlock, onLogs });
      return () => undefined;
    },
  }),
}));
vi.mock("@chicmoz-pkg/message-bus", () => ({
  publishMessage: (_topic: string, payload: { l1BlockNumber: unknown }) => {
    const height = BigInt(String(payload.l1BlockNumber));
    if (seam.failPublish.has(height)) {
      return Promise.reject(new Error("publish rejected"));
    }
    seam.published.push(height);
    return Promise.resolve();
  },
  generateSvc: () => ({}),
  startSubscribe: () => Promise.resolve(),
}));
// Rows keyed by the WHERE parameters; writes apply setHeight's greatest() upsert.
vi.mock("@chicmoz-pkg/postgres-helper", async () => {
  const { getTableName } = await import("drizzle-orm");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  type Table = Parameters<typeof getTableName>[0];
  const key = (table: Table, values: unknown[]) =>
    [getTableName(table), ...values].join("|");
  const max = (stored: bigint, next: bigint | undefined) =>
    next !== undefined && next > stored ? next : stored;
  return {
    generateSvc: () => ({}),
    getDb: () => ({
      select: () => ({
        from: (table: Table) => ({
          where: (where: Parameters<typeof dialect.sqlToQuery>[0]) => ({
            limit: () => {
              const row = seam.rows.get(
                key(table, dialect.sqlToQuery(where).params),
              );
              return Promise.resolve(row ? [row] : []);
            },
          }),
        }),
      }),
      insert: (table: Table) => ({
        values: (values: {
          contractName: string;
          contractAddress: string;
          eventName: string;
          latestPendingHeight?: bigint;
          latestFinalizedHeight?: bigint;
        }) => ({
          onConflictDoUpdate: () => {
            const rowKey = key(table, [
              values.contractName,
              values.contractAddress,
              values.eventName,
            ]);
            const row = (seam.rows.get(rowKey) as Row | undefined) ?? {
              latestPendingHeight: 0n,
              latestFinalizedHeight: 0n,
            };
            seam.rows.set(rowKey, {
              latestPendingHeight: max(
                row.latestPendingHeight,
                values.latestPendingHeight,
              ),
              latestFinalizedHeight: max(
                row.latestFinalizedHeight,
                values.latestFinalizedHeight,
              ),
            });
            return Promise.resolve();
          },
        }),
      }),
    }),
  };
});
vi.mock("../src/logger.js", () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

afterAll(() => {
  vi.unstubAllEnvs();
});

const ADDRESSES = loadFixture("testnet", "node-info", "node-info").data.result
  .l1ContractAddresses;
const address = (name: keyof typeof ADDRESSES) => {
  const value = ADDRESSES[name];
  if (typeof value !== "string") {
    throw new Error(`node-info has no ${name}`);
  }
  return value;
};
const recorded = (name: string) =>
  loadFixture("testnet", "l1-log", name).data.log;
const proofVerified = recorded("proof-verified-33608");

// Stored before each test, above the rollup's genesis; also the finalized
// block when a live watcher starts, so it resumes after the stored height.
const H0 = 12_200_000n;
const TIP = H0 + 800n; // finalized tip: the first poll reads one 500-block chunk
const CHUNK_END = H0 + 501n;
const [B1, B2, B3] = [H0 + 100n, H0 + 200n, H0 + 300n];

// Built by production getL1Contracts over the fake client.
let contracts: AztecContracts;

// One representative per way a callback handles a failing log; the other
// event types of a family share its callback shape and its tracker calls.
const ROLLUP = {
  family: "rollup L2ProofVerified (catches per log)",
  contract: "rollup" as const,
  eventName: "L2ProofVerified",
  template: proofVerified,
  watch: () => watchRollupL2ProofVerified({ contracts, latestHeight: H0 }),
};
const GOVERNANCE = {
  family: "governance GovernanceProposerUpdated (batch throws)",
  contract: "governance" as const,
  eventName: "GovernanceProposerUpdated",
  // Hand-made: the callback reads only the args and the log's position.
  template: {
    ...proofVerified,
    address: address("governanceAddress"),
    eventName: "GovernanceProposerUpdated",
    args: {
      governanceProposer: getAddress(address("governanceProposerAddress")),
    },
  },
  watch: () =>
    watchGovernanceStructuredEvent({
      contract: contracts.governance,
      contractName: "governance",
      eventName: "GovernanceProposerUpdated",
      latestHeight: H0,
      callbacksFactory: governanceProposerUpdatedEventCallbacks,
    }),
};
const GENERIC = {
  family: "generic rollup ValidatorQueued (batch throws, dedupes)",
  contract: "rollup" as const,
  eventName: "ValidatorQueued",
  template: recorded("rollup-validator-queued"),
  watch: () =>
    watchContractEventsGeneric({
      name: "rollup",
      contract: contracts.rollup,
      latestHeight: H0,
    }),
};
type Family = typeof ROLLUP | typeof GOVERNANCE | typeof GENERIC;

// The generic dedupe is module-level, so every log gets a fresh logIndex.
let nextLogIndex = 0;
const logsAt = (f: Family, heights: bigint[]) =>
  heights.map((blockNumber) => ({
    ...f.template,
    blockNumber,
    logIndex: nextLogIndex++,
  }));
const stream = (f: Family) => `${contracts[f.contract].address}.${f.eventName}`;
const heightKey = (f: Family) =>
  [
    "heights",
    f.contract,
    contracts[f.contract].address,
    f === GENERIC ? `${f.eventName}(generic)` : f.eventName,
  ].join("|");
const stored = (f: Family) => {
  const row = seam.rows.get(heightKey(f)) as Row | undefined;
  if (!row) {
    throw new Error(`no stored height for ${f.family}`);
  }
  return row;
};
const readsOf = (f: Family) =>
  seam.reads
    .filter((read) => read.stream === stream(f))
    .map(({ fromBlock, toBlock }) => ({ fromBlock, toBlock }));
const poll = () =>
  getAllContractsEvents({ contracts, latestHeight: TIP, toBlock: "finalized" });
const watchedFrom = (f: Family) => seam.watches.get(stream(f))?.fromBlock;

beforeAll(async () => {
  initClient();
  seam.rows.set("l1ContractAddresses|TESTNET", { addresses: ADDRESSES });
  seam.contractReads = {
    getGovernance: getAddress(address("governanceAddress")),
    governanceProposer: getAddress(address("governanceProposerAddress")),
  };
  contracts = await getL1Contracts();
});

beforeEach(() => {
  seam.tip = TIP;
  seam.chain.clear();
  seam.reads.splice(0);
  seam.watches.clear();
  seam.published.splice(0);
  seam.failPublish.clear();
  for (const f of [ROLLUP, GOVERNANCE, GENERIC]) {
    seam.rows.set(heightKey(f), {
      latestPendingHeight: H0,
      latestFinalizedHeight: H0,
    });
  }
});

// The stored height is the tracker's, the poller's range override and the
// callback's together; a callback with a stub tracker shows none of the first two.
describe("finalized poller heights", () => {
  // Catches a batch that never stores its height, so the backfill never advances.
  it.each([ROLLUP, GOVERNANCE, GENERIC])(
    "$family: a delivered batch stores the end of the range it read and the next poll starts after it",
    async (f) => {
      seam.chain.set(stream(f), logsAt(f, [B1, B2, B3]));
      await poll();
      expect(seam.published).toEqual([B1, B2, B3]);
      expect(stored(f).latestFinalizedHeight).toBe(CHUNK_END);
      await poll();
      expect(stored(f).latestFinalizedHeight).toBe(TIP);
      expect(readsOf(f)).toEqual([
        { fromBlock: H0 + 1n, toBlock: CHUNK_END },
        { fromBlock: CHUNK_END + 1n, toBlock: "finalized" },
      ]);
    },
  );

  // Catches a failed publish that leaves its log outside every later poll's range.
  it.each([GOVERNANCE, GENERIC])(
    "$family: the next poll re-reads and delivers a log whose publish failed",
    async (f) => {
      seam.chain.set(stream(f), logsAt(f, [B1, B2, B3]));
      seam.failPublish.add(B2);
      await expect(poll()).rejects.toThrow("publish rejected");
      expect(stored(f).latestFinalizedHeight).toBeLessThan(B2);
      seam.failPublish.clear();
      await poll();
      expect([...new Set(seam.published)]).toEqual([B1, B2, B3]);
      expect(stored(f).latestFinalizedHeight).toBe(CHUNK_END);
    },
  );

  // Catches a failing stream that keeps the streams polled after it from running.
  it("a stream whose poll rejects does not hold back the streams polled after it", async () => {
    seam.chain.set(stream(GOVERNANCE), logsAt(GOVERNANCE, [B2]));
    seam.chain.set(stream(GENERIC), logsAt(GENERIC, [B1, B3]));
    seam.failPublish.add(B2);
    await expect(poll()).rejects.toThrow("publish rejected");
    expect(seam.published).toEqual([B1, B3]);
    expect(stored(GENERIC).latestFinalizedHeight).toBe(CHUNK_END);
  });
});

describe("live watcher heights", () => {
  // Catches a pending height that never moves, so each restart re-watches from the old block.
  it.each([ROLLUP, GOVERNANCE, GENERIC])(
    "$family: a restarted watcher resumes after the last delivered log",
    async (f) => {
      await f.watch();
      expect(watchedFrom(f)).toBe(H0 + 1n);
      seam.watches.get(stream(f))?.onLogs(logsAt(f, [B1, B2, B3]));
      // onLogs is fire-and-forget; every fake settles in microtasks.
      await new Promise((resolve) => setImmediate(resolve));
      expect(seam.published).toEqual([B1, B2, B3]);
      expect(stored(f).latestPendingHeight).toBe(B3);
      await f.watch();
      expect(watchedFrom(f)).toBe(B3 + 1n);
    },
  );
});
