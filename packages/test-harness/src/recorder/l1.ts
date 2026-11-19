import {
  FeeJuicePortalAbi,
  GovernanceAbi,
  GovernanceProposerAbi,
  InboxAbi,
  OutboxAbi,
  RegistryAbi,
  RollupAbi,
} from "@aztec-foundation/l1-artifacts";
import {
  createPublicClient,
  custom,
  decodeEventLog,
  type Abi,
  type AbiEvent,
  type EIP1193RequestFn,
} from "viem";
import { type FixtureSource } from "../fixtures/format.js";
import { jsonRpc } from "./http.js";
import { type Limiter } from "./limiter.js";
import { writeFixture } from "./write.js";

/** The ABIs ethereum-listener reads each `AztecContracts` key with. */
const ABIS: Record<string, Abi> = {
  rollup: RollupAbi,
  registry: RegistryAbi,
  inbox: InboxAbi,
  outbox: OutboxAbi,
  feeJuicePortal: FeeJuicePortalAbi,
  governance: GovernanceAbi,
  governanceProposer: GovernanceProposerAbi,
};

export type L1Search = {
  source: FixtureSource;
  aztecVersion: string;
  rpc: string;
  name: string;
  contract: string;
  address: `0x${string}`;
  eventName: string;
  args?: Record<string, bigint | string>;
  from: bigint;
  to: bigint;
  /** `backward` takes the newest match, `forward` the oldest. */
  direction: "forward" | "backward";
  chunk: bigint;
  maxRequests: number;
  limiter: Limiter;
  log: (line: string) => void;
};

const limitedTransport = (rpc: string, limiter: Limiter) =>
  custom(
    {
      request: (({ method, params }: { method: string; params?: unknown }) =>
        jsonRpc(limiter, rpc, method, params)) as EIP1193RequestFn,
    },
    { retryCount: 0 },
  );

const isNamedArgs = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Records the first log matching `eventName` (and `args`) in `from..to`,
 * walking in `chunk`-sized windows, with its block timestamp and the sender
 * of its transaction, which the listener's callbacks read alongside the log.
 */
export const recordL1Log = async (s: L1Search): Promise<boolean> => {
  const abi = ABIS[s.contract];
  if (!abi) {
    throw new Error(`unknown contract ${s.contract}; one of ${Object.keys(ABIS).join(", ")}`);
  }
  const event = abi.find(
    (item): item is AbiEvent => item.type === "event" && item.name === s.eventName,
  );
  if (!event) {
    throw new Error(`${s.contract} has no event ${s.eventName}`);
  }
  const filter = Object.entries(s.args ?? {});
  const unknown = filter.filter(([k]) => !event.inputs.some((i) => i.indexed && i.name === k));
  if (unknown.length > 0) {
    throw new Error(`${s.eventName} has no indexed input ${unknown.map(([k]) => k).join(", ")}`);
  }
  if (s.from > s.to) {
    throw new Error("--from is above --to");
  }
  const client = createPublicClient({ transport: limitedTransport(s.rpc, s.limiter) });
  let requests = 0;
  for (
    let lo = s.direction === "forward" ? s.from : s.to - s.chunk + 1n;
    s.direction === "forward" ? lo <= s.to : lo + s.chunk - 1n >= s.from;
    lo += s.direction === "forward" ? s.chunk : -s.chunk
  ) {
    if (requests++ >= s.maxRequests) {
      break;
    }
    const fromBlock = lo < s.from ? s.from : lo;
    const toBlock = lo + s.chunk - 1n > s.to ? s.to : lo + s.chunk - 1n;
    const logs = await client.getContractEvents({
      address: s.address,
      abi,
      eventName: s.eventName,
      args: s.args,
      fromBlock,
      toBlock,
    });
    // viem spreads the provider's log over its decoded result, so a provider field
    // named `args` or `eventName` would win, and it drops a zero-valued filter:
    // decode again from topics and data alone, and filter again.
    const matches = logs.flatMap((log) => {
      const args: unknown = decodeEventLog({
        abi: [event],
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        strict: true,
      }).args;
      if (!isNamedArgs(args)) {
        throw new Error(`${s.eventName} has unnamed inputs; the listener reads args by name`);
      }
      const hit = filter.every(([k, want]) => String(args[k]).toLowerCase() === String(want).toLowerCase());
      return hit ? [{ log, args }] : [];
    });
    const match = s.direction === "forward" ? matches[0] : matches[matches.length - 1];
    if (!match) {
      continue;
    }
    const { log, args } = match;
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    const tx = await client.getTransaction({ hash: log.transactionHash });
    s.log(
      `wrote ${writeFixture({
        source: s.source,
        kind: "l1-log",
        name: s.name,
        aztecVersion: s.aztecVersion,
        origin: `eth_getLogs ${s.contract}.${s.eventName} at L1 block ${log.blockNumber}`,
        features: [],
        data: {
          contract: s.contract,
          eventName: s.eventName,
          // Named fields only: providers add others (e.g. `blockTimestamp`), which stay out.
          log: {
            address: log.address,
            blockHash: log.blockHash,
            blockNumber: log.blockNumber,
            data: log.data,
            logIndex: log.logIndex,
            removed: log.removed,
            topics: [...log.topics],
            transactionHash: log.transactionHash,
            transactionIndex: log.transactionIndex,
            eventName: s.eventName,
            args,
          },
          blockTimestamp: block.timestamp,
          transactionFrom: tx.from,
        },
      })}`,
    );
    return true;
  }
  s.log(`no ${s.contract}.${s.eventName} log after ${requests} windows`);
  return false;
};
