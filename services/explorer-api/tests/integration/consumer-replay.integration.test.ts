import { type Canonical, canonical, deliver } from "@chicmoz/test-harness";
import { type EventHandler } from "@chicmoz-pkg/message-bus";
import {
  type ChicmozChainInfoEvent,
  type ChicmozMessageBusPayload,
  type PendingTxsEvent,
} from "@chicmoz-pkg/message-registry";
import { getTableName, sql } from "drizzle-orm";
import { type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import {
  producerFrameData,
  recordedFrameData,
} from "./support/recorded-blocks.js";

type Schema = typeof import("../../src/svcs/database/schema/index.js") &
  typeof import("../../src/svcs/database/schema/l1/index.js") &
  typeof import("../../src/svcs/database/schema/l1/fee-juice-portal-deposit.js") &
  typeof import("../../src/svcs/database/schema/l2/rpc-node.js");

/**
 * A table a consumer writes. `clocks`: the columns its store sets to
 * `new Date()` on every write, the only values a redelivery may change.
 */
type Compared = { table: PgTable; clocks?: readonly string[] };

type ReplayCase = {
  consumer: string;
  handler: () => Promise<EventHandler>;
  message: () => Record<string, unknown>;
  /** With `finality: "stored"`, the first table holds the log's rows. */
  tables: (s: Schema) => Compared[];
  seed?: () => Promise<void>;
  /**
   * An L1 log, delivered as the live watcher sends it (`isFinalized: false`)
   * before the finalized poller's copy. "stored": the store keeps the flag;
   * "ignored": both copies make the same write.
   */
  finality?: "stored" | "ignored";
};

const RECEIVED = "../../src/events/received";
const handlerOf =
  (file: string, name: string) => async (): Promise<EventHandler> =>
    ((await import(`${RECEIVED}/${file}`)) as Record<string, EventHandler>)[
      name
    ];

const l1Frame = (name: string, eventType: string) =>
  producerFrameData(name, eventType, "ethereum-listener") as Record<
    string,
    unknown
  >;
const CHAIN_INFO = () =>
  recordedFrameData("chain-info-event-1") as ChicmozChainInfoEvent;
const PENDING = () =>
  recordedFrameData("pending-txs-event-1") as PendingTxsEvent;
const PROPOSED = () =>
  l1Frame("governance-proposed", "L1_GOVERNANCE_PROPOSED_EVENT");
const governance = (name: string) => handlerOf("on-governance-events.js", name);
// Constructed: no ProposalExecuted or ProposalDropped log is recorded; this
// ends the recorded proposal 8.
const PROPOSAL_8_ENDED = () => ({
  proposalId: "8",
  l1BlockNumber: 11969400,
  l1BlockHash: `0x${"ab".repeat(32)}`,
  l1BlockTimestamp: 1792676300000,
  l1TransactionHash: `0x${"cd".repeat(32)}`,
  l1LogIndex: 5,
  isFinalized: true,
});
// Unchecked, as on the bus: the handler alone decides what it accepts.
const send = async (handler: EventHandler, message: Record<string, unknown>) =>
  deliver(handler, message as ChicmozMessageBusPayload);
const seedProposal = async () =>
  send(await governance("governanceProposedHandler")(), PROPOSED());

const CHAIN_INFO_TABLES = (s: Schema): Compared[] => [
  { table: s.l2ChainInfoTable, clocks: ["updatedAt"] },
  { table: s.l2RollupVersionObservationTable, clocks: ["lastSeenAt"] },
];

const CASES: ReplayCase[] = [
  {
    consumer: "chain info",
    handler: handlerOf("on-chain-info.js", "chainInfoHandler"),
    message: CHAIN_INFO,
    tables: CHAIN_INFO_TABLES,
  },
  {
    // Constructed: no recorded frame carries token metadata.
    consumer: "staking asset info",
    handler: handlerOf("on-staking-asset-info.js", "stakingAssetInfoHandler"),
    message: () => ({
      chainInfo: {
        ...CHAIN_INFO().chainInfo,
        stakingAssetSymbol: "STK",
        stakingAssetDecimals: 18,
        feeJuiceSymbol: "FJ",
        feeJuiceDecimals: 18,
      },
    }),
    tables: CHAIN_INFO_TABLES,
  },
  {
    consumer: "rpc node alive",
    handler: handlerOf("on-l2-rpc-node.js", "l2RpcNodeAliveHandler"),
    message: () =>
      producerFrameData(
        "local-network/rpc-node-alive",
        "L2_RPC_NODE_ALIVE_EVENT",
      ) as Record<string, unknown>,
    tables: (s) => [{ table: s.l2RpcNodeTable, clocks: ["lastSeenAt"] }],
  },
  {
    consumer: "rpc node info",
    handler: handlerOf("on-rpc-node-info.js", "l2RpcNodeInfoHandler"),
    message: () =>
      producerFrameData(
        "local-network/rpc-node",
        "L2_RPC_NODE_INFO_EVENT",
      ) as Record<string, unknown>,
    tables: (s) => [
      { table: s.l2RpcNodeTable, clocks: ["lastSeenAt"] },
      { table: s.l2RollupVersionObservationTable, clocks: ["lastSeenAt"] },
    ],
  },
  {
    consumer: "pending txs",
    handler: handlerOf("on-pending-txs.js", "pendingTxHandler"),
    message: PENDING,
    tables: (s) => [{ table: s.l2Tx }, { table: s.droppedTx }],
  },
  {
    // Constructed: the local network drops nothing. Shaped as aztec-listener's
    // dropped-tx verifier publishes it, for the recorded pending tx.
    consumer: "dropped txs",
    handler: handlerOf("on-dropped-txs.js", "droppedTxHandler"),
    message: () => ({
      txs: PENDING().txs.map((tx) => ({
        txHash: tx.txHash,
        createdAsPendingAt: tx.birthTimestamp,
        droppedAt: tx.birthTimestamp + 600_000,
        dropReason: "expired",
      })),
    }),
    seed: async () =>
      send(
        await handlerOf("on-pending-txs.js", "pendingTxHandler")(),
        PENDING(),
      ),
    tables: (s) => [{ table: s.l2Tx }, { table: s.droppedTx }],
  },
  {
    // Constructed: no balance frame is recorded. The recorded fee payer's balance.
    consumer: "contract instance balance",
    handler: handlerOf(
      "on-contract-instance-balance.js",
      "contractInstanceBalanceHandler",
    ),
    message: () => {
      const [tx] = PENDING().txs;
      return {
        contractAddress: tx.feePayer,
        balance: "1000000000000000000",
        timestamp: tx.birthTimestamp,
        sourceTxHash: tx.txHash,
        blockNumber: 12,
      };
    },
    tables: (s) => [{ table: s.contractInstanceBalance }],
  },
  {
    consumer: "l1 block proposed",
    handler: handlerOf(
      "on-l1-rollup-contract-events.js",
      "l1L2BlockProposedHandler",
    ),
    message: () =>
      l1Frame("checkpoint-proposed-33600", "L1_L2_BLOCK_PROPOSED_EVENT"),
    tables: (s) => [{ table: s.l1L2BlockProposedTable }],
    finality: "stored",
  },
  {
    consumer: "l1 proof verified",
    handler: handlerOf(
      "on-l1-rollup-contract-events.js",
      "l1L2ProofVerifiedHandler",
    ),
    message: () =>
      l1Frame("proof-verified-33608", "L1_L2_PROOF_VERIFIED_EVENT"),
    tables: (s) => [{ table: s.l1L2ProofVerifiedTable }],
    finality: "stored",
  },
  {
    consumer: "l1 generic contract event",
    handler: handlerOf(
      "on-l1-rollup-contract-events.js",
      "l1GenericContractEventHandler",
    ),
    message: () =>
      l1Frame("rollup-validator-queued", "L1_GENERIC_CONTRACT_EVENT"),
    tables: (s) => [{ table: s.l1GenericContractEventTable }],
    finality: "stored",
  },
  {
    consumer: "l1 fee juice portal deposit",
    handler: handlerOf(
      "on-l1-fee-juice-portal-deposit.js",
      "l1FeeJuicePortalDepositHandler",
    ),
    message: () =>
      l1Frame("deposit-to-aztec-public", "L1_FEE_JUICE_PORTAL_DEPOSIT_EVENT"),
    tables: (s) => [{ table: s.l1FeeJuicePortalDepositTable }],
    finality: "stored",
  },
  {
    consumer: "governance proposed",
    handler: governance("governanceProposedHandler"),
    message: PROPOSED,
    tables: (s) => [{ table: s.l1GovernanceProposalsTable }],
    finality: "stored",
  },
  {
    consumer: "governance vote cast with the proposal snapshot",
    handler: governance("governanceVoteCastHandler"),
    message: () =>
      l1Frame("governance-vote-cast", "L1_GOVERNANCE_VOTE_CAST_EVENT"),
    seed: seedProposal,
    tables: (s) => [
      { table: s.l1GovernanceVotesTable },
      { table: s.l1GovernanceProposalsTable },
    ],
    finality: "stored",
  },
  {
    consumer: "governance proposal executed",
    handler: governance("governanceProposalExecutedHandler"),
    message: PROPOSAL_8_ENDED,
    seed: seedProposal,
    tables: (s) => [{ table: s.l1GovernanceProposalsTable }],
    finality: "ignored",
  },
  {
    consumer: "governance proposal dropped",
    handler: governance("governanceProposalDroppedHandler"),
    message: PROPOSAL_8_ENDED,
    seed: seedProposal,
    tables: (s) => [{ table: s.l1GovernanceProposalsTable }],
    finality: "ignored",
  },
];

// Kafka delivers at least once: a handler error is rethrown so the message
// comes again, and the L1 listener publishes every log twice, pending and
// then finalized. A mocked database (the consumer-replay corpus) shows one
// delivery's writes; only Postgres applies the unique keys, conflict targets
// and upserts that decide what a second delivery leaves behind.
describe("a message delivered twice leaves the rows one delivery leaves", () => {
  let api: ExplorerApiForTest;
  let schema: Schema;
  let reset: (tables: Compared[]) => Promise<void>;
  let dump: (tables: Compared[]) => Promise<Record<string, Canonical[]>>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    schema = {
      ...(await import("../../src/svcs/database/schema/index.js")),
      ...(await import("../../src/svcs/database/schema/l1/index.js")),
      ...(await import(
        "../../src/svcs/database/schema/l1/fee-juice-portal-deposit.js"
      )),
      ...(await import("../../src/svcs/database/schema/l2/rpc-node.js")),
    };
    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    // Cases share tables; each starts from empty ones.
    reset = async (tables) => {
      for (const { table } of tables) {
        await getDb().execute(sql`truncate table ${table} cascade`);
      }
    };
    dump = async (tables) => {
      const out: Record<string, Canonical[]> = {};
      for (const { table, clocks = [] } of tables) {
        const rows = await getDb().select().from(table);
        out[getTableName(table)] = rows
          .map((row) => canonical(row, { dbTimeKeys: clocks }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return out;
    };
  });

  afterAll(async () => {
    await api?.close();
  });

  it.each(CASES.map((c) => [c.consumer, c] as const))(
    "%s",
    async (_consumer, c) => {
      const tables = c.tables(schema);
      await reset(tables);
      await c.seed?.();
      const handler = await c.handler();
      const finalizedRows = (rows: Record<string, Canonical[]>) =>
        rows[getTableName(tables[0].table)].filter(
          (row) => (row as { isFinalized?: Canonical }).isFinalized === true,
        ).length;
      // Equal dumps prove nothing unless the first delivery changed a row.
      const deliverTwice = async (
        message: Record<string, unknown>,
        changes = true,
      ) => {
        const prior = await dump(tables);
        await send(handler, message);
        const once = await dump(tables);
        if (changes) {
          expect(once, "the delivery changed no row").not.toEqual(prior);
        } else {
          expect(once, "the finalized copy changed a row").toEqual(prior);
        }
        await send(handler, message);
        expect(await dump(tables)).toEqual(once);
        return once;
      };

      if (!c.finality) {
        await deliverTwice(c.message());
        return;
      }
      const pending = await deliverTwice({
        ...c.message(),
        isFinalized: false,
      });
      const finalized = await deliverTwice(
        c.message(),
        c.finality === "stored",
      );
      if (c.finality === "stored") {
        expect(finalizedRows(pending), "finalized rows, pending copy").toBe(0);
        expect(finalizedRows(finalized), "finalized rows, both copies").toBe(1);
      }
    },
  );
});
