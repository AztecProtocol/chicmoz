import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type EventHandler } from "@chicmoz-pkg/message-bus";
import { type ChicmozMessageBusPayload } from "@chicmoz-pkg/message-registry";
import {
  REPO_ROOT,
  canonical,
  frameBytes,
  listFixtures,
  loadFixture,
} from "@chicmoz/test-harness";
import { BSON } from "bson";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every database write and network fetch a consumer makes, in call order.
const seam = vi.hoisted(() => {
  const calls: { seam: string; args: unknown[] }[] = [];
  const record =
    (name: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ seam: name, args });
      return Promise.resolve(result);
    };
  const metadata = {
    title: "fixed metadata from the replay test",
    github_pr: null,
    forum_link: null,
    description: null,
  };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  // A mocked module is evaluated once, so the network is read through a getter.
  const env = { network: "" };
  const subscribed: EventHandler[] = [];
  return { calls, record, metadata, logger, env, subscribed };
});

vi.mock("../../src/environment.js", () => ({
  get L2_NETWORK_ID() {
    return seam.env.network;
  },
}));
vi.mock("../../src/logger.js", () => ({ logger: seam.logger }));
vi.mock("../../src/svcs/message-bus/index.js", () => ({
  startSubscribe: (handler: EventHandler) => {
    seam.subscribed.push(handler);
    return Promise.resolve();
  },
}));
vi.mock("../../src/svcs/database/controllers/l2block/add_l1_data.js", () => ({
  addL1L2BlockProposed: seam.record("addL1L2BlockProposed"),
  addL1L2ProofVerified: seam.record("addL1L2ProofVerified"),
}));
vi.mock(
  "../../src/svcs/database/controllers/l1/fee-juice-portal-deposit/store.js",
  () => ({ store: seam.record("feeJuicePortalDeposit.store") }),
);
vi.mock(
  "../../src/svcs/database/controllers/l1/generic-contract-event/store.js",
  () => ({ store: seam.record("genericContractEvent.store") }),
);
vi.mock("../../src/svcs/database/controllers/l1/governance/index.js", () => ({
  store: {
    storeGovernanceProposed: seam.record("storeGovernanceProposed"),
    storeGovernanceVoteCast: seam.record("storeGovernanceVoteCast"),
  },
}));
vi.mock("../../src/svcs/metadata-resolver/index.js", () => ({
  resolvePayloadMetadata: seam.record("resolvePayloadMetadata", seam.metadata),
}));
vi.mock("../../src/svcs/database/controllers/l2/index.js", () => ({
  storeChainInfo: seam.record("storeChainInfo"),
  storeL2RpcNode: seam.record("storeL2RpcNode"),
  storeL2RpcNodeError: seam.record("storeL2RpcNodeError"),
  storeL2RpcNodeHealth: seam.record("storeL2RpcNodeHealth"),
}));
vi.mock("../../src/svcs/database/index.js", () => ({
  controllers: { l2: { tips: { upsertTips: seam.record("upsertTips") } } },
}));
vi.mock("../../src/svcs/database/controllers/l2Tx/index.js", () => ({
  storeOrUpdateL2Tx: seam.record("storeOrUpdateL2Tx"),
}));
vi.mock("../../src/svcs/database/controllers/dropped-tx/index.js", () => ({
  removeDroppedTxByHash: seam.record("removeDroppedTxByHash", 0),
}));
// Only the compile-result consumer uses it; its real module reads the Redis
// environment on import.
vi.mock(
  "../../src/svcs/http-server/routes/controllers/contract-classes.js",
  () => ({
    readClassWithArtifact: seam.record("readClassWithArtifact"),
    storeArtifactIfAbsent: seam.record("storeArtifactIfAbsent"),
  }),
);

// Committed topics carry no namespace.
vi.stubEnv("KAFKA_NAMESPACE", "");
// The pending-tx schema defaults an absent birthTimestamp to the clock.
vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });

// `network` is the L2_NETWORK_ID the producer ran with.
type Frame = {
  name: string;
  network: string;
  topic: string;
  bytes: Uint8Array;
};

const BYTE_HEX = /^(?:[0-9a-f]{2})+$/;

const producerFrames = (
  origin: string,
  network: string,
  path: string,
): Frame[] => {
  const file = JSON.parse(
    readFileSync(join(REPO_ROOT, path), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  if (Object.keys(file).length === 0) {
    throw new Error(`${origin} committed no frames`);
  }
  return Object.entries(file).map(([name, { topic, bson }]) => {
    if (
      typeof topic !== "string" ||
      typeof bson !== "string" ||
      !BYTE_HEX.test(bson)
    ) {
      throw new Error(`${origin} ${name} is not a frame`);
    }
    return {
      name: `${origin} ${name}`,
      network,
      topic,
      bytes: new Uint8Array(Buffer.from(bson, "hex")),
    };
  });
};

const FRAMES: Frame[] = [
  ...producerFrames(
    "ethereum-listener",
    "TESTNET",
    "services/ethereum-listener/tests/__snapshots__/l1-frames.json.snap",
  ),
  ...producerFrames(
    "aztec-listener",
    "SANDBOX",
    "services/aztec-listener/tests/characterization/__snapshots__/producer-frames.json.snap",
  ),
  ...listFixtures("local-network", "frame").map((name) => {
    const fixture = loadFixture("local-network", "frame", name);
    const { l2NetworkId, eventType } = fixture.data;
    return {
      name: `recorded local-network/${name}`,
      network: l2NetworkId,
      topic: `${l2NetworkId}__${eventType}`,
      bytes: frameBytes(fixture),
    };
  }),
];

// What explorer-api hands to the bus at startup when configured for `network`.
const subscriptions = async (network: string): Promise<EventHandler[]> => {
  vi.resetModules();
  seam.env.network = network;
  seam.subscribed.length = 0;
  const { subscribeHandlers } = await import(
    "../../src/events/received/index.js"
  );
  await subscribeHandlers();
  return [...seam.subscribed];
};

const SUBSCRIBED = new Map<string, EventHandler[]>();
for (const network of new Set(FRAMES.map((frame) => frame.network))) {
  SUBSCRIBED.set(network, await subscriptions(network));
}

// The bus consumer's acceptance rule: a BSON value whose `data` is an object.
const busDecode = (bytes: Uint8Array): ChicmozMessageBusPayload => {
  const decoded: Record<string, unknown> = BSON.deserialize(bytes);
  if (typeof decoded.data !== "object") {
    throw new Error("frame carries no data object");
  }
  // Unchecked, as on the bus: the handler alone decides what it accepts.
  return decoded.data as ChicmozMessageBusPayload;
};

beforeEach(() => {
  seam.calls.length = 0;
  vi.clearAllMocks();
});

// A schema test sees values; only the handlers explorer-api subscribes on the
// frame's exact topic, fed the committed bytes, show what a new consumer
// would write for a frame already on that topic.
describe("committed frames replayed into the explorer-api consumers", () => {
  it.each(FRAMES.map((frame) => [frame.name, frame] as const))(
    "%s reaches the database with the same arguments",
    async (_name, frame) => {
      const consumers = (SUBSCRIBED.get(frame.network) ?? []).filter(
        (handler) => handler.topic === frame.topic,
      );
      expect(
        consumers,
        `no ${frame.network} subscription on ${frame.topic}`,
      ).not.toHaveLength(0);

      // For a handler that reads the network when called, not on import.
      seam.env.network = frame.network;
      for (const consumer of consumers) {
        await expect(
          consumer.cb(busDecode(frame.bytes)),
        ).resolves.toBeUndefined();
      }

      // The pending-tx consumer logs a failed parse instead of throwing.
      expect(seam.logger.error).not.toHaveBeenCalled();
      expect(seam.logger.warn).not.toHaveBeenCalled();
      expect(canonical(seam.calls)).toMatchSnapshot();
    },
  );
});
