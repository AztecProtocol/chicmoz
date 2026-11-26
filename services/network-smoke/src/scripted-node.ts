import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import {
  BlockNumber,
  CheckpointNumber,
} from "@aztec-labs/foundation/branded-types";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import {
  type ApiHandler,
  createNamespacedSafeJsonRpcServer,
  startHttpRpcServer,
} from "@aztec-labs/foundation/json-rpc/server";
import {
  type BlockData,
  type BlockParameter,
  BlockHash,
  GENESIS_CHECKPOINT_HEADER_HASH,
  inspectBlockParameter,
  type L2BlockTag,
  type L2TipId,
  type L2Tips,
} from "@aztec-labs/stdlib/block";
import {
  AztecNodeApiSchema,
  type BlockIncludeOptions,
  type BlockResponse,
  type BlocksIncludeOptions,
} from "@aztec-labs/stdlib/interfaces/client";
import { type ScriptStatus } from "./script-control.js";
import {
  type NodeState,
  type ScriptedBlock,
  buildScript,
  recordedNodeInfo,
} from "./scripted-chain.js";

export type ScriptedNode = {
  rpcUrl: string;
  controlUrl: string;
  close(): Promise<void>;
};

const heightAt = (state: NodeState, tag: L2BlockTag | "latest") => {
  switch (tag) {
    case "latest":
    case "proposed":
      return state.chain.length - 1;
    case "checkpointed":
      return state.checkpointed;
    case "proven":
      return state.proven;
    case "finalized":
      return state.finalized;
  }
};

/** The block `param` names on the current chain, as a node that pruned the rest would find it. */
const find = (
  state: NodeState,
  param: BlockParameter,
): ScriptedBlock | undefined => {
  const byHash = (hash: BlockHash) =>
    state.chain.find((b) => b.hash === hash.toString());
  if (typeof param === "number") {
    return state.chain[param];
  }
  if (typeof param === "string") {
    return state.chain[heightAt(state, param)];
  }
  if (BlockHash.isBlockHash(param)) {
    return byHash(param);
  }
  if ("number" in param && "hash" in param) {
    const block = state.chain[param.number];
    return block?.hash === param.hash.toString() ? block : undefined;
  }
  if ("number" in param) {
    return state.chain[param.number];
  }
  if ("hash" in param) {
    return byHash(param.hash);
  }
  if ("archive" in param) {
    return state.chain.find((b) => b.block.archive.root.equals(param.archive));
  }
  return state.chain[heightAt(state, param.tag)];
};

const responseOf = async (
  { block }: ScriptedBlock,
  options: BlockIncludeOptions = {},
): Promise<BlockResponse> => ({
  header: block.header,
  archive: block.archive,
  hash: await block.hash(),
  checkpointNumber: block.checkpointNumber,
  indexWithinCheckpoint: block.indexWithinCheckpoint,
  number: block.number,
  ...(options.includeTransactions ? { body: block.body } : {}),
});

const tipOf = (state: NodeState, height: number): L2TipId => ({
  block: { number: BlockNumber(height), hash: state.chain[height].hash },
  checkpoint: {
    number: CheckpointNumber(height),
    hash:
      height === 0
        ? GENESIS_CHECKPOINT_HEADER_HASH.toString()
        : state.chain[height].checkpointHash,
  },
});

const listen = async (server: Server, host: string, port: number) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return (server.address() as AddressInfo).port;
};

const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * A JSON-RPC Aztec node that serves a fixed script of chain states, one at a
 * time, through the SDK's own server and `AztecNodeApiSchema`. It implements
 * only what the listeners call; any other method answers "Method not found",
 * as a real node does for an unknown method. A separate control port reads
 * the script and moves it to its next state.
 */
export const startScriptedNode = async ({
  host = "127.0.0.1",
  rpcPort,
  controlPort,
  log = (line: string) => process.stdout.write(`${line}\n`),
}: {
  host?: string;
  rpcPort: number;
  controlPort: number;
  log?: (line: string) => void;
}): Promise<ScriptedNode> => {
  const { states, facts } = await buildScript();
  const nodeInfo = recordedNodeInfo();
  let current = 0;
  let tipReads = 0;
  const state = () => states[current];

  const handler = {
    getNodeInfo: () => Promise.resolve(nodeInfo),
    getChainTips: (): Promise<L2Tips> => {
      tipReads++;
      const s = state();
      const proposed = s.chain.length - 1;
      return Promise.resolve({
        proposed: {
          number: BlockNumber(proposed),
          hash: s.chain[proposed].hash,
        },
        checkpointed: tipOf(s, s.checkpointed),
        proven: tipOf(s, s.proven),
        finalized: tipOf(s, s.finalized),
      });
    },
    getBlockNumber: (tag?: L2BlockTag) => {
      tipReads++;
      return Promise.resolve(BlockNumber(heightAt(state(), tag ?? "proposed")));
    },
    getBlock: async (param: BlockParameter, options?: BlockIncludeOptions) => {
      const block = find(state(), param);
      log(
        `state ${current} getBlock ${inspectBlockParameter(param)}: ${block?.hash ?? "none"}`,
      );
      return block ? responseOf(block, options) : undefined;
    },
    getBlockData: async (
      param: BlockParameter,
    ): Promise<BlockData | undefined> => {
      const found = find(state(), param);
      return found
        ? {
            header: found.block.header,
            archive: found.block.archive,
            blockHash: await found.block.hash(),
            checkpointNumber: found.block.checkpointNumber,
            indexWithinCheckpoint: found.block.indexWithinCheckpoint,
          }
        : undefined;
    },
    getBlocks: (
      from: BlockNumber,
      limit: number,
      options: BlocksIncludeOptions = {},
    ) => {
      const s = state();
      const last = options.onlyCheckpointed
        ? s.checkpointed
        : s.chain.length - 1;
      const blocks = s.chain.slice(from, Math.min(from + limit, last + 1));
      log(
        `state ${current} getBlocks ${from}+${limit}: ${blocks.map((b) => b.block.number).join(",") || "none"}`,
      );
      return Promise.all(blocks.map((block) => responseOf(block, options)));
    },
    getPendingTxs: () => Promise.resolve([]),
    getPublicStorageAt: () => Promise.resolve(Fr.ZERO),
  };
  // The schema's generic method types cannot describe a partial handler; the
  // server needs only each implemented name to be a function.
  const api = [handler, AztecNodeApiSchema] as unknown as ApiHandler;
  // Both namespaces, as the real node registers them: the SDK client calls
  // aztec_*, and the listener's fallback and run.ts's readiness check node_*.
  const rpc = await startHttpRpcServer(
    createNamespacedSafeJsonRpcServer({ aztec: api, node: api }),
    { host, port: rpcPort },
  );

  const status = (): ScriptStatus => ({ ...facts, current, tipReads });
  const control = createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/script") {
      reply(200, status());
    } else if (req.method === "POST" && req.url === "/script/step") {
      if (current + 1 >= states.length) {
        reply(409, { error: `already at the last state, ${state().label}` });
        return;
      }
      current++;
      const s = state();
      log(
        `state ${current} ${s.label}: proposed ${s.chain.length - 1} ${s.chain.at(-1)?.hash}, checkpointed ${s.checkpointed}, proven ${s.proven}, finalized ${s.finalized}`,
      );
      reply(200, { current, label: s.label });
    } else {
      reply(404, { error: "not found" });
    }
  });
  const controlBound = await listen(control, host, controlPort);
  log(
    `state 0 ${state().label}; ${states.length} states, prune at ${facts.pruneAt}`,
  );

  return {
    rpcUrl: `http://${host}:${rpc.port}`,
    controlUrl: `http://${host}:${controlBound}`,
    close: async () => {
      await Promise.all([close(rpc), close(control)]);
    },
  };
};
