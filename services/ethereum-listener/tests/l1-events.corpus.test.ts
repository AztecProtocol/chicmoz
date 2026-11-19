import {
  FIXTURE_SOURCES,
  canonical,
  canonicalJson,
  frameBytes,
  listFixtures,
  loadFixture,
  type FixtureData,
  type FixtureSource,
} from "@chicmoz/test-harness";
import { chicmozChainInfoSchema } from "@chicmoz-pkg/types";
import { BSON } from "bson";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initClient } from "../src/network-client/client/index.js";
import {
  depositToAztecPublicEventCallbacks,
  genericOnLogs,
  l2BlockProposedEventCallbacks,
  l2ProofVerifiedEventCallbacks,
  proposedEventCallbacks,
  voteCastEventCallbacks,
} from "../src/network-client/contracts/callbacks/index.js";
import { getL1Contracts } from "../src/svcs/database/controllers/l1-contract-addresses.js";

const seam = vi.hoisted(() => {
  // Read at import: the recorded logs are testnet, and topics carry no namespace.
  vi.stubEnv("L2_NETWORK_ID", "TESTNET");
  vi.stubEnv("KAFKA_NAMESPACE", undefined);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });
  const timestamps = new Map<string, bigint>();
  const senders = new Map<string, string>();
  const reads = new Map<string, unknown>();
  const answer = <T>(value: T | undefined, what: string): Promise<T> =>
    value === undefined
      ? Promise.reject(new Error(`no answer for ${what}`))
      : Promise.resolve(value);
  return {
    timestamps,
    senders,
    reads,
    published: [] as { topic: string; bytes: Uint8Array }[],
    errors: [] as string[],
    rows: [] as { addresses: unknown }[],
    client: {
      getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
        answer(timestamps.get(String(blockNumber)), "getBlock").then(
          (timestamp) => ({ timestamp }),
        ),
      getTransaction: ({ hash }: { hash: string }) =>
        answer(senders.get(hash), "getTransaction").then((from) => ({ from })),
      readContract: ({ functionName }: { functionName: string }) =>
        answer(reads.get(functionName), functionName),
    },
  };
});

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPublicClient: () => seam.client,
}));
vi.mock("@chicmoz-pkg/message-bus", async () => {
  const { BSON: bson } = await import("bson");
  return {
    // The bus serializes `{ data: payload }` when it publishes.
    publishMessage: (topic: string, payload: unknown) => {
      seam.published.push({ topic, bytes: bson.serialize({ data: payload }) });
      return Promise.resolve();
    },
    generateSvc: () => ({}),
    startSubscribe: () => Promise.resolve(),
  };
});
vi.mock("@chicmoz-pkg/postgres-helper", () => ({
  generateSvc: () => ({}),
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(seam.rows) }),
      }),
    }),
  }),
}));
vi.mock("../src/logger.js", () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message: string) => {
      seam.errors.push(message);
    },
  },
}));

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type RecordedLog = FixtureData["l1-log"];

const LOG_NAMES = listFixtures("testnet", "l1-log");
const recorded = new Map(
  LOG_NAMES.map((name) => [name, loadFixture("testnet", "l1-log", name).data]),
);
const recordedLog = (name: string) => {
  const data = recorded.get(name);
  if (!data) {
    throw new Error(`missing l1-log fixture ${name}`);
  }
  return data;
};

// Governance reads are not recorded. These answers are hand-made: proposal 8
// created at its Proposed block, read once voting is open and the recorded
// vote is its only ballot.
const constructGovernanceReads = () => {
  const { proposal } = recordedLog("governance-proposed").log.args;
  const { amount } = recordedLog("governance-vote-cast").log.args;
  const { governanceProposerAddress } = loadFixture(
    "testnet",
    "node-info",
    "node-info",
  ).data.result.l1ContractAddresses;
  if (
    typeof proposal !== "string" ||
    typeof amount !== "bigint" ||
    governanceProposerAddress === undefined
  ) {
    throw new Error("recorded governance values changed shape");
  }
  // viem returns checksummed addresses; the node reports lowercase ones.
  const governanceProposer = getAddress(governanceProposerAddress);
  return {
    getURI: "https://example.com/governance/proposal-8.md",
    getOriginalPayload: getAddress(
      "0x1111111111111111111111111111111111111111",
    ),
    governanceProposer,
    getProposalState: 1, // Active
    totalPowerAt: 10n ** 27n,
    getProposal: {
      config: {
        votingDelay: 60n,
        votingDuration: 3600n,
        executionDelay: 60n,
        gracePeriod: 3600n,
        quorum: 10n ** 17n,
        requiredYeaMargin: 4n * 10n ** 16n,
        minimumVotes: 10n ** 24n,
      },
      cachedState: 0, // Pending
      payload: proposal,
      proposer: governanceProposer,
      creation: recordedLog("governance-proposed").blockTimestamp,
      summedBallot: { yea: amount, nay: 0n },
    },
  };
};

// The finalized-events poller's setting; every payload carries it.
const wrapper = {
  isFinalized: true,
  updateHeight: () => undefined,
  storeHeight: () => Promise.resolve(),
};

// The recorded log is what viem hands each callback; only its static type differs.
const asLogs = <T>(log: RecordedLog["log"]): T => [log] as unknown as T;

// The callback production gives each event (watch-events.ts, get-events.ts).
const ROUTES: Partial<
  Record<string, (log: RecordedLog["log"]) => Promise<void>>
> = {
  "rollup.CheckpointProposed": (log) =>
    l2BlockProposedEventCallbacks(wrapper).onLogs(asLogs(log)),
  "rollup.L2ProofVerified": (log) =>
    l2ProofVerifiedEventCallbacks(wrapper).onLogs(asLogs(log)),
  "rollup.ValidatorQueued": (log) =>
    genericOnLogs({ ...wrapper, logs: asLogs(log) }),
  "feeJuicePortal.DepositToAztecPublic": (log) =>
    depositToAztecPublicEventCallbacks(wrapper).onLogs(asLogs(log)),
  "governance.Proposed": (log) =>
    proposedEventCallbacks(wrapper).onLogs(asLogs(log)),
  "governance.VoteCast": (log) =>
    voteCastEventCallbacks(wrapper).onLogs(asLogs(log)),
};

describe("L1 event frames from recorded logs", () => {
  const outcomes = new Map<
    string,
    { published: typeof seam.published; errors: string[] }
  >();

  // Each log is delivered once and every answer depends only on its input, so
  // the module-level timestamp cache and generic-event dedupe cannot make one
  // case depend on another.
  beforeAll(async () => {
    initClient();
    for (const { log, blockTimestamp, transactionFrom } of recorded.values()) {
      seam.timestamps.set(String(log.blockNumber), blockTimestamp);
      if (transactionFrom !== undefined) {
        seam.senders.set(log.transactionHash, transactionFrom);
      }
    }
    for (const [fn, value] of Object.entries(constructGovernanceReads())) {
      seam.reads.set(fn, value);
    }
    for (const name of LOG_NAMES) {
      const { contract, eventName, log } = recordedLog(name);
      const route = ROUTES[`${contract}.${eventName}`];
      if (!route) {
        throw new Error(`no production callback for ${contract}.${eventName}`);
      }
      seam.published.splice(0);
      seam.errors.splice(0);
      await route(log);
      outcomes.set(name, {
        published: [...seam.published],
        errors: [...seam.errors],
      });
    }
  });

  // The rollup and deposit callbacks log a failed parse instead of throwing,
  // so a dropped event shows only as a missing publish.
  it("publishes one frame per recorded log, with the committed topic and bytes", async () => {
    expect(
      Object.fromEntries(
        [...outcomes].map(([name, { published, errors }]) => [
          name,
          { publishes: published.length, errors },
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        LOG_NAMES.map((name) => [name, { publishes: 1, errors: [] }]),
      ),
    );
    const frames = Object.fromEntries(
      [...outcomes].map(([name, { published }]) => {
        const [{ topic, bytes }] = published;
        const data: unknown = BSON.deserialize(bytes).data;
        return [
          name,
          {
            eventType: topic.split("__")[1],
            topic,
            data,
            bson: Buffer.from(bytes).toString("hex"),
          },
        ];
      }),
    );
    await expect(canonicalJson(frames)).toMatchFileSnapshot(
      "__snapshots__/l1-frames.json.snap",
    );
  });
});

type ChainInfoMessage = {
  data: { chainInfo: { l1ContractAddresses: unknown } };
};

const L2_NETWORK_BY_SOURCE = {
  "local-network": "SANDBOX",
  testnet: "TESTNET",
} as const satisfies Record<FixtureSource, string>;

// What onChainInfo stores: aztec-listener's chicmozChainInfoSchema output for
// the node's answer, after the bus's BSON and jsonb's JSON round trips.
const storedAddresses = (
  source: FixtureSource,
  result: FixtureData["node-info"]["result"],
): unknown => {
  const chainInfo = chicmozChainInfoSchema.parse({
    l2NetworkId: L2_NETWORK_BY_SOURCE[source],
    ...result,
  });
  const message = BSON.deserialize(
    BSON.serialize({ data: { chainInfo } }),
  ) as ChainInfoMessage;
  return JSON.parse(JSON.stringify(message.data.chainInfo.l1ContractAddresses));
};

describe("L1 contract addresses read back from the database", () => {
  // A read-back that rejects what the writer stored stops the listener at boot.
  it.each(
    FIXTURE_SOURCES.flatMap((source) =>
      listFixtures(source, "node-info").map((name) => [source, name] as const),
    ),
  )("parses what onChainInfo stored for %s/%s", async (source, name) => {
    const { result } = loadFixture(source, "node-info", name).data;
    seam.rows = [{ addresses: storedAddresses(source, result) }];
    expect(canonical(await getL1Contracts())).toMatchSnapshot();
  });

  // Pins the rebuilt writer input to bytes aztec-listener really published.
  it("rebuilds the addresses the recorded local-network chain-info frame carries", () => {
    const frame = BSON.deserialize(
      frameBytes(loadFixture("local-network", "frame", "chain-info-event-1")),
    ) as ChainInfoMessage;
    const { result } = loadFixture(
      "local-network",
      "node-info",
      "node-info",
    ).data;
    expect(canonical(storedAddresses("local-network", result))).toStrictEqual(
      canonical(
        JSON.parse(JSON.stringify(frame.data.chainInfo.l1ContractAddresses)),
      ),
    );
  });
});
