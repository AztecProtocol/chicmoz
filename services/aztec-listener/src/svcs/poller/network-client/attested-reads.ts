import { L2Block } from "@aztec-labs/aztec.js/block";
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { type L2Tips } from "@aztec-labs/stdlib/block";
import { NodeCheckError, bodyFault } from "./block-stream-source.js";
import { callNodeFunction } from "./index.js";
import { type RpcNode } from "./pool.js";

/** `final`: at or below the serving node's own finalized tip, on the stream's rollup version. */
export type AttestedBlock = { block: L2Block; final: boolean };

export type AttestedReader = {
  node: RpcNode;
  /** The node's tips, read before any of its blocks. */
  tips: L2Tips;
  /** The node's block at `height`, or undefined when it has none. */
  getBlock(height: number): Promise<AttestedBlock | undefined>;
};

/**
 * Pins `node` for one request. Its tips and rollup version are read before
 * its blocks, and a finalized block cannot change, so `final` holds for every
 * block read after them. Only the stream's own `rollupVersion` gets `final`.
 * A caller whose session two slow reads can outlast passes its `heartbeat`,
 * which runs between them.
 */
export const openAttestedReader = async (
  node: RpcNode,
  rollupVersion: number | undefined,
  heartbeat?: () => Promise<void>,
): Promise<AttestedReader> => {
  const tips = await callNodeFunction("getChainTips", [], node);
  await heartbeat?.();
  const info = await callNodeFunction("getNodeInfo", [], node);
  // The RPC client resolves a null answer to undefined, whatever the type.
  if (tips === undefined || info === undefined) {
    throw new Error(
      `Node ${node.name} answered its tips or node info with nothing`,
    );
  }
  const version =
    rollupVersion !== undefined && info.rollupVersion === rollupVersion
      ? BigInt(rollupVersion)
      : undefined;
  return {
    node,
    tips,
    getBlock: async (height) => {
      const response = await callNodeFunction(
        "getBlock",
        [BlockNumber(height), { includeTransactions: true }],
        node,
      );
      if (response === undefined) {
        return undefined;
      }
      const number = response.header.globalVariables.blockNumber;
      if (number !== height) {
        throw new NodeCheckError(
          `Node ${node.name} sent block ${number} where ${height} was asked`,
        );
      }
      if (response.body === undefined) {
        throw new NodeCheckError(
          `Node ${node.name} sent block ${height} without its body`,
        );
      }
      const block = new L2Block(
        response.archive,
        response.header,
        response.body,
        response.checkpointNumber,
        response.indexWithinCheckpoint,
      );
      const fault = await bodyFault(block);
      if (fault !== undefined) {
        throw new NodeCheckError(`Node ${node.name} ${fault}`);
      }
      return {
        block,
        final:
          version !== undefined &&
          block.header.globalVariables.version.toBigInt() === version &&
          height <= tips.finalized.block.number,
      };
    },
  };
};
