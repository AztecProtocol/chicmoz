import { deliver } from "@chicmoz/test-harness";
import { type EventHandler } from "@chicmoz-pkg/message-bus";
import { type ChicmozMessageBusPayload } from "@chicmoz-pkg/message-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import { governanceSignalCast as SIGNAL } from "./support/fixtures.js";
import { producerFrameData } from "./support/recorded-blocks.js";

const HOUR_MS = 60 * 60 * 1000;
const l1Frame = (name: string, eventType: string) =>
  producerFrameData(name, eventType, "ethereum-listener") as Record<
    string,
    unknown
  >;
const VOTE = l1Frame("governance-vote-cast", "L1_GOVERNANCE_VOTE_CAST_EVENT");
const EVENT = l1Frame("rollup-validator-queued", "L1_GENERIC_CONTRACT_EVENT");
// Constructed: the recorded event without its log position, in an earlier
// hour. Delivered once, pending only: without a position its copies are not
// recognised as one log.
const EVENT_WITHOUT_POSITION = {
  ...EVENT,
  l1TransactionHash: null,
  l1LogIndex: null,
  l1BlockTimestamp: Number(EVENT.l1BlockTimestamp) - 2 * HOUR_MS,
};

const READS = [
  "votes of a proposal",
  "signals for a proposal's payload",
  "signals",
  "signals of a round",
  "signals of a payload",
  "signal count of the payload's round",
  "L1 contract events",
  "L1 contract events per hour",
  "L1 contract events without a log position",
] as const;
type Read = {
  read: () => Promise<unknown[]>;
  /** After the pending copy and a redelivery of it. */
  pending: unknown[];
  /** After the finalized copy too. */
  finalized: unknown[];
};

// The L1 listener publishes a log as the live watcher sees it, then again
// once its block is finalized; the stores keep a row for each copy.
describe("an L1 log is read once, the finalized copy once it is stored", () => {
  let api: ExplorerApiForTest;
  let reads: Record<(typeof READS)[number], Read>;
  let deliverCopies: (isFinalized: boolean) => Promise<void>;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
    const { governanceSignalCastHandler, governanceVoteCastHandler } =
      await import("../../src/events/received/on-governance-events.js");
    const { l1GenericContractEventHandler } = await import(
      "../../src/events/received/on-l1-rollup-contract-events.js"
    );
    const { l1 } = await import("../../src/svcs/database/controllers/index.js");
    const { queries } = l1.governance;
    const logs: [EventHandler, Record<string, unknown>][] = [
      [governanceVoteCastHandler, VOTE],
      [governanceSignalCastHandler, SIGNAL],
      [l1GenericContractEventHandler, EVENT],
    ];
    deliverCopies = async (isFinalized) => {
      for (const [handler, message] of logs) {
        await deliver(handler, {
          ...message,
          isFinalized,
        } as ChicmozMessageBusPayload);
      }
    };

    const finality = (rows: { isFinalized: boolean }[]) =>
      rows.map((row) => row.isFinalized);
    const listed = { pending: [false], finalized: [true] };
    const counted = (count: unknown) => ({
      pending: [count],
      finalized: [count],
    });
    const hours =
      Math.ceil(
        (Date.now() - EVENT_WITHOUT_POSITION.l1BlockTimestamp) / HOUR_MS,
      ) + 1;
    const eventHour =
      Math.floor(Number(EVENT.l1BlockTimestamp) / HOUR_MS) * HOUR_MS;
    reads = {
      "votes of a proposal": {
        read: async () =>
          finality(await queries.getProposalVotes(String(VOTE.proposalId))),
        ...listed,
      },
      "signals for a proposal's payload": {
        read: async () =>
          finality(await queries.getProposalSignals(SIGNAL.payloadAddress)),
        ...listed,
      },
      signals: {
        read: async () => finality(await queries.getSignals()),
        ...listed,
      },
      "signals of a round": {
        read: async () =>
          finality(await queries.getSignalsByRound(SIGNAL.round)),
        ...listed,
      },
      "signals of a payload": {
        read: async () =>
          finality(await queries.getSignalsByPayload(SIGNAL.payloadAddress)),
        ...listed,
      },
      "signal count of the payload's round": {
        read: async () => [
          (await queries.getPayloadRound(SIGNAL.payloadAddress, SIGNAL.round))
            ?.signalCount,
        ],
        ...counted(1n),
      },
      "L1 contract events": {
        read: async () =>
          finality(
            (await l1.contractEvents.get()).filter(
              (event) => event.l1LogIndex !== null,
            ),
          ),
        ...listed,
      },
      "L1 contract events per hour": {
        read: async () =>
          (await l1.contractEvents.getHourlyCounts(hours))
            .filter((bucket) => bucket.hourStartMs === eventHour)
            .map((bucket) => bucket.count),
        ...counted(1),
      },
      "L1 contract events without a log position": {
        read: async () =>
          finality(
            (await l1.contractEvents.get()).filter(
              (event) => event.l1LogIndex === null,
            ),
          ),
        pending: [false],
        finalized: [false],
      },
    };

    await deliverCopies(false);
    await deliverCopies(false);
    await deliver(l1GenericContractEventHandler, {
      ...EVENT_WITHOUT_POSITION,
      isFinalized: false,
    } as ChicmozMessageBusPayload);
  });

  afterAll(async () => {
    await api?.close();
  });

  it.each(READS)("%s, after the pending copy and its redelivery", async (name) => {
    const { read, pending } = reads[name];
    expect(await read()).toEqual(pending);
  });

  describe("after the finalized copy too", () => {
    beforeAll(async () => {
      await deliverCopies(true);
    });

    it.each(READS)("%s", async (name) => {
      const { read, finalized } = reads[name];
      expect(await read()).toEqual(finalized);
    });
  });
});
