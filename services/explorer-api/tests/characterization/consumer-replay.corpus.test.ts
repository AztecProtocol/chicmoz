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
  return { calls, record, metadata, logger };
});

vi.mock("../../src/environment.js", () => ({ L2_NETWORK_ID: "TESTNET" }));
vi.mock("../../src/logger.js", () => ({ logger: seam.logger }));
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

// The pending-tx schema defaults an absent birthTimestamp to the clock.
vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });

const rollup = await import(
  "../../src/events/received/on-l1-rollup-contract-events.js"
);
const deposit = await import(
  "../../src/events/received/on-l1-fee-juice-portal-deposit.js"
);
const governance = await import(
  "../../src/events/received/on-governance-events.js"
);
const chainInfo = await import("../../src/events/received/on-chain-info.js");
const rpcNodeInfo = await import(
  "../../src/events/received/on-rpc-node-info.js"
);
const rpcNode = await import("../../src/events/received/on-l2-rpc-node.js");
const tips = await import("../../src/events/received/on-l2-tips.js");
const pendingTxs = await import("../../src/events/received/on-pending-txs.js");

// The first three redeliver forever when their parse throws, so they run first.
const HANDLERS = new Map<string, EventHandler>([
  ["L1_L2_BLOCK_PROPOSED_EVENT", rollup.l1L2BlockProposedHandler],
  ["L1_L2_PROOF_VERIFIED_EVENT", rollup.l1L2ProofVerifiedHandler],
  ["L1_FEE_JUICE_PORTAL_DEPOSIT_EVENT", deposit.l1FeeJuicePortalDepositHandler],
  ["L1_GENERIC_CONTRACT_EVENT", rollup.l1GenericContractEventHandler],
  ["L1_GOVERNANCE_PROPOSED_EVENT", governance.governanceProposedHandler],
  ["L1_GOVERNANCE_VOTE_CAST_EVENT", governance.governanceVoteCastHandler],
  ["CHAIN_INFO_EVENT", chainInfo.chainInfoHandler],
  ["L2_RPC_NODE_INFO_EVENT", rpcNodeInfo.l2RpcNodeInfoHandler],
  ["L2_RPC_NODE_ERROR_EVENT", rpcNode.l2RpcNodeErrorHandler],
  ["L2_TIPS_EVENT", tips.l2TipsHandler],
  ["PENDING_TXS_EVENT", pendingTxs.pendingTxHandler],
]);

type Frame = { name: string; eventType: string; bytes: Uint8Array };

const BYTE_HEX = /^(?:[0-9a-f]{2})+$/;

const producerFrames = (origin: string, path: string): Frame[] => {
  const file = JSON.parse(
    readFileSync(join(REPO_ROOT, path), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  if (Object.keys(file).length === 0) {
    throw new Error(`${origin} committed no frames`);
  }
  return Object.entries(file).map(([name, { eventType, topic, bson }]) => {
    if (
      typeof eventType !== "string" ||
      typeof topic !== "string" ||
      !topic.endsWith(`__${eventType}`) ||
      typeof bson !== "string" ||
      !BYTE_HEX.test(bson)
    ) {
      throw new Error(`${origin} ${name} is not a frame`);
    }
    return {
      name: `${origin} ${name}`,
      eventType,
      bytes: new Uint8Array(Buffer.from(bson, "hex")),
    };
  });
};

const order = (eventType: string) => {
  const index = [...HANDLERS.keys()].indexOf(eventType);
  return index === -1 ? HANDLERS.size : index;
};

const FRAMES: Frame[] = [
  ...producerFrames(
    "ethereum-listener",
    "services/ethereum-listener/tests/__snapshots__/l1-frames.json.snap",
  ),
  ...producerFrames(
    "aztec-listener",
    "services/aztec-listener/tests/characterization/__snapshots__/producer-frames.json.snap",
  ),
  ...listFixtures("local-network", "frame").map((name) => {
    const fixture = loadFixture("local-network", "frame", name);
    return {
      name: `recorded local-network/${name}`,
      eventType: fixture.data.eventType,
      bytes: frameBytes(fixture),
    };
  }),
].sort((a, b) => order(a.eventType) - order(b.eventType));

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

// A schema test sees values; only the real handler fed the committed bytes
// shows what a new consumer would write for a frame already on the topic.
describe("committed frames replayed into the explorer-api consumers", () => {
  it.each(FRAMES.map((frame) => [frame.name, frame] as const))(
    "%s reaches the database with the same arguments",
    async (_name, frame) => {
      const handler = HANDLERS.get(frame.eventType);
      if (!handler) {
        throw new Error(`no consumer for ${frame.eventType}`);
      }
      expect(handler.topic).toMatch(new RegExp(`__${frame.eventType}$`));

      await expect(handler.cb(busDecode(frame.bytes))).resolves.toBeUndefined();

      // The pending-tx consumer logs a failed parse instead of throwing.
      expect(seam.logger.error).not.toHaveBeenCalled();
      expect(seam.logger.warn).not.toHaveBeenCalled();
      expect(canonical(seam.calls)).toMatchSnapshot();
    },
  );
});
