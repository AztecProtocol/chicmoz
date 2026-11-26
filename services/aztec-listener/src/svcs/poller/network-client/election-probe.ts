import {
  type AztecNode,
  createAztecNodeClient,
} from "@aztec-labs/aztec.js/node";
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { jsonStringify } from "@aztec-labs/foundation/json-rpc";
import { type JsonRpcFetch } from "@aztec-labs/foundation/json-rpc/client";
import { type L2Tips } from "@aztec-labs/stdlib/block";
import { type RpcNode, withV5NodeNamespaceFallback } from "./pool.js";

/** Election answers are small; the cap keeps a faulty node from streaming an unbounded body into memory. */
export const ELECTION_PROBE_MAX_BYTES = 64 * 1024;

/** The election's reads from one node. */
export type ElectionReader = {
  getChainTips(): Promise<L2Tips>;
  /** The hash of the node's block at `blockNumber`, recomputed from its header. */
  getBlockHash(blockNumber: number): Promise<string | undefined>;
};

/** Opens one node's reads for one election. */
export type OpenElectionReader = (node: RpcNode) => ElectionReader;

const readCapped = async (response: Response, maxBytes: number) => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

// The SDK's fetch has no deadline and reads the whole body.
const boundedFetch =
  (maxBytes: number, deadline: () => AbortSignal | undefined): JsonRpcFetch =>
  async (host, body, extraHeaders = {}) => {
    const response = await fetch(host, {
      method: "POST",
      body: jsonStringify(body),
      headers: { "content-type": "application/json", ...extraHeaders },
      signal: deadline(),
    });
    const text = await readCapped(response, maxBytes);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return { response: JSON.parse(text) as unknown, headers: response.headers };
  };

class BoundedClient {
  deadline?: AbortSignal;
  readonly node: AztecNode;

  constructor(url: string, maxBytes: number) {
    this.node = createAztecNodeClient(url, {
      fetch: withV5NodeNamespaceFallback(
        boundedFetch(maxBytes, () => this.deadline),
      ),
    });
  }
}

/**
 * Election reads over HTTP: every read opened for a node in one election
 * shares one `timeoutMs` deadline, and each answer is capped at `maxBytes`.
 */
export const boundedElectionReaders = (
  timeoutMs: number,
  maxBytes = ELECTION_PROBE_MAX_BYTES,
): OpenElectionReader => {
  const clients = new Map<string, BoundedClient>();
  return (node) => {
    let bounded = clients.get(node.url);
    if (bounded === undefined) {
      bounded = new BoundedClient(node.url, maxBytes);
      clients.set(node.url, bounded);
    }
    bounded.deadline = AbortSignal.timeout(timeoutMs);
    const client = bounded.node;
    return {
      getChainTips: () => client.getChainTips(),
      getBlockHash: async (blockNumber) => {
        const block = await client.getBlock(BlockNumber(blockNumber));
        return block === undefined
          ? undefined
          : (await block.header.hash()).toString();
      },
    };
  };
};
