import { L2Block } from "@aztec-labs/aztec.js/block";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, type AztecNode } from "@aztec-labs/aztec.js/node";
import { BlockNumber, CheckpointNumber } from "@aztec-labs/foundation/branded-types";
import { jsonStringify } from "@aztec-labs/foundation/json-rpc";
import { ContractClassPublishedEvent } from "@aztec-labs/protocol-contracts/class-registry";
import { ContractInstancePublishedEvent } from "@aztec-labs/protocol-contracts/instance-registry";
import { type FixtureData, type FixtureSource } from "../fixtures/format.js";
import { boundedJson, jsonRpc } from "./http.js";
import { type Limiter } from "./limiter.js";
import { writeFixture } from "./write.js";

export const BLOCK_FEATURES = [
  "empty",
  "public-logs",
  "public-data-writes",
  "class-publish",
  "instance-deploy",
] as const;
export type BlockFeature = (typeof BLOCK_FEATURES)[number];

export type NodeRecording = {
  url: string;
  source: FixtureSource;
  limiter: Limiter;
  log: (line: string) => void;
};

type Node = { client: AztecNode; rpc: (method: string) => Promise<unknown> } & NodeRecording;

const connect = (r: NodeRecording): Node => {
  const client = createAztecNodeClient(r.url, {
    maxBatchSize: 1,
    // Same wire format as the SDK's default transport, through the bounded, redirect-refusing request.
    fetch: async (host, body, extraHeaders) => {
      const res = await boundedJson(r.limiter, host, {
        method: "POST",
        body: jsonStringify(body),
        headers: extraHeaders,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from the node`);
      }
      return { response: res.json, headers: res.headers };
    },
  });
  // node-info and l2-tips keep the wire JSON, before the SDK turns it into classes.
  const rpc = (method: string) => jsonRpc(r.limiter, r.url, method, []);
  return { ...r, client, rpc };
};

/** Records node info and chain tips; returns the node's version for the other fixtures. */
export const recordNodeInfo = async (r: NodeRecording): Promise<string> => {
  const node = connect(r);
  const info = (await node.rpc("aztec_getNodeInfo")) as FixtureData["node-info"]["result"];
  writeFixture({
    source: r.source,
    kind: "node-info",
    name: "node-info",
    aztecVersion: info.nodeVersion,
    origin: "aztec_getNodeInfo()",
    features: [],
    data: { result: info },
  });
  const tips = (await node.rpc("aztec_getChainTips")) as FixtureData["l2-tips"]["result"];
  writeFixture({
    source: r.source,
    kind: "l2-tips",
    name: "l2-tips",
    aztecVersion: info.nodeVersion,
    origin: "aztec_getChainTips()",
    features: [],
    data: { result: tips },
  });
  return info.nodeVersion;
};

type FetchedBlock = { data: FixtureData["l2-block"]; features: BlockFeature[] };

/** Builds the block exactly as aztec-listener does before publishing it (`network-client/index.ts` `getBlock`). */
const fetchBlock = async (node: Node, height: number): Promise<FetchedBlock> => {
  const res = await node.client.getBlock(BlockNumber(height), { includeTransactions: true });
  if (!res?.body) {
    throw new Error(`block ${height}: no block with a body`);
  }
  const block = new L2Block(
    res.archive,
    res.header,
    res.body,
    res.checkpointNumber,
    res.indexWithinCheckpoint,
  );
  const txs = res.body.txEffects;
  const classIds = txs
    .flatMap((t) => t.contractClassLogs)
    .filter((l) => ContractClassPublishedEvent.isContractClassPublishedEvent(l))
    .map((l) => ContractClassPublishedEvent.fromLog(l).contractClassId.toString());
  const instances = txs
    .flatMap((t) => t.privateLogs)
    .filter((l) => ContractInstancePublishedEvent.isContractInstancePublishedEvent(l))
    .map((l) => ContractInstancePublishedEvent.fromLog(l).address);
  // The node is the ground truth: every decoded class and instance must be known to it.
  for (const id of classIds) {
    if (!(await node.client.getContractClass(Fr.fromString(id)))) {
      throw new Error(`block ${height}: node does not know class ${id}`);
    }
  }
  for (const address of instances) {
    if (!(await node.client.getContract(address))) {
      throw new Error(`block ${height}: node does not know instance ${address.toString()}`);
    }
  }
  const count = (pick: (t: (typeof txs)[number]) => unknown[]) =>
    txs.reduce((n, t) => n + pick(t).length, 0);
  const counts = {
    txEffects: txs.length,
    noteHashes: count((t) => t.noteHashes),
    nullifiers: count((t) => t.nullifiers),
    l2ToL1Msgs: count((t) => t.l2ToL1Msgs),
    publicDataWrites: count((t) => t.publicDataWrites),
    publicLogs: count((t) => t.publicLogs),
    privateLogs: count((t) => t.privateLogs),
    contractClassLogs: count((t) => t.contractClassLogs),
  };
  const features: BlockFeature[] = [];
  if (counts.txEffects === 0) {
    features.push("empty");
  }
  if (counts.publicLogs > 0) {
    features.push("public-logs");
  }
  if (counts.publicDataWrites > 0) {
    features.push("public-data-writes");
  }
  if (classIds.length > 0) {
    features.push("class-publish");
  }
  if (instances.length > 0) {
    features.push("instance-deploy");
  }
  return {
    features,
    data: {
      // stdlib types it `Buffer<ArrayBufferLike>`, which this package's @types/node does not know.
      hex: Buffer.from(block.toBuffer() as Uint8Array).toString("hex"),
      expected: {
        height: Number(res.number),
        hash: res.hash.toString(),
        archiveRoot: res.archive.root.toString(),
        checkpointNumber: Number(res.checkpointNumber),
        indexWithinCheckpoint: Number(res.indexWithinCheckpoint),
        txHashes: txs.map((t) => t.txHash.toString()),
        counts,
        contractClassIds: classIds,
        contractInstanceAddresses: instances.map((a) => a.toString()),
      },
    },
  };
};

const writeBlock = (
  r: NodeRecording,
  aztecVersion: string,
  height: number,
  b: FetchedBlock,
  extra: string[] = [],
) =>
  writeFixture({
    source: r.source,
    kind: "l2-block",
    name: `block-${height}`,
    aztecVersion,
    origin: `aztec_getBlock(${height}, { includeTransactions: true })`,
    features: [...b.features, ...extra],
    data: b.data,
  });

export const recordBlocks = async (
  r: NodeRecording,
  aztecVersion: string,
  heights: number[],
): Promise<void> => {
  const node = connect(r);
  for (const h of heights) {
    r.log(`wrote ${writeBlock(r, aztecVersion, h, await fetchBlock(node, h))}`);
  }
};

/** Walks `from..to` and records the first block showing each wanted feature. */
export const scanBlocks = async (
  r: NodeRecording,
  aztecVersion: string,
  from: number,
  to: number,
  want: BlockFeature[],
): Promise<BlockFeature[]> => {
  const node = connect(r);
  const missing = new Set(want);
  for (let h = from; h <= to && missing.size > 0; h++) {
    const b = await fetchBlock(node, h);
    if (b.features.some((f) => missing.has(f))) {
      b.features.forEach((f) => missing.delete(f));
      r.log(`wrote ${writeBlock(r, aztecVersion, h, b)}`);
    }
  }
  return [...missing];
};

/**
 * Records a checkpoint (with its L1 publish coordinates) and all of its
 * blocks. With `findMultiBlock`, walks down from `checkpoint` to the first one
 * holding at least two blocks, at most `maxTries` checkpoints.
 */
export const recordCheckpoint = async (
  r: NodeRecording,
  aztecVersion: string,
  checkpoint: number,
  findMultiBlock: boolean,
  maxTries = 20,
): Promise<number> => {
  const node = connect(r);
  for (let n = checkpoint, tries = 0; tries < maxTries; n--, tries++) {
    const cp = await node.client.getCheckpoint(CheckpointNumber(n), {
      includeL1PublishInfo: true,
    });
    if (!cp) {
      throw new Error(`checkpoint ${n} not found`);
    }
    if (findMultiBlock && cp.blockCount < 2) {
      continue;
    }
    const start = Number(cp.startBlock);
    const heights = Array.from({ length: cp.blockCount }, (_, i) => start + i);
    for (const h of heights) {
      writeBlock(r, aztecVersion, h, await fetchBlock(node, h), [`checkpoint-${n}`]);
    }
    writeFixture({
      source: r.source,
      kind: "checkpoint",
      name: `checkpoint-${n}`,
      aztecVersion,
      origin: `aztec_getCheckpoint(${n}, { includeL1PublishInfo: true })`,
      features: cp.blockCount > 1 ? ["multi-block-checkpoint"] : [],
      data: {
        number: Number(cp.number),
        archiveRoot: cp.archive.root.toString(),
        startBlock: start,
        blockCount: cp.blockCount,
        l1: cp.l1?.published
          ? {
              blockNumber: BigInt(cp.l1.blockNumber),
              blockHash: cp.l1.blockHash.toString(),
              timestamp: BigInt(cp.l1.timestamp),
            }
          : undefined,
      },
    });
    return n;
  }
  throw new Error(`no multi-block checkpoint in ${maxTries} tries below ${checkpoint}`);
};
