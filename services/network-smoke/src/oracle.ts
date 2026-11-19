import { RollupAbi } from "@aztec-foundation/l1-artifacts";
import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { type AztecNode } from "@aztec-labs/aztec.js/node";
import { createPublicClient, http } from "viem";

/** What the node and the rollup on anvil say about one L2 block. */
export type Expected = {
  height: number;
  hash: string;
  archive: string;
  proposal?: { l1BlockNumber: bigint; l1TransactionHash: string };
};

/**
 * Heights 1..`upTo` from the node, each joined to the rollup's
 * `CheckpointProposed` log carrying its archive root. The local network
 * builds one block per checkpoint, so every block has its own log.
 */
export const expectedBlocks = async (
  node: AztecNode,
  anvilUrl: string,
  upTo: number,
): Promise<Expected[]> => {
  const { rollupAddress } = await node.getL1ContractAddresses();
  const l1 = createPublicClient({
    transport: http(anvilUrl, { timeout: 10_000 }),
  });
  const logs = await l1.getContractEvents({
    address: rollupAddress.toString(),
    abi: RollupAbi,
    eventName: "CheckpointProposed",
    fromBlock: 0n,
  });
  const byArchive = new Map(
    logs.map((log) => [
      String(log.args.archive).toLowerCase(),
      {
        l1BlockNumber: log.blockNumber,
        l1TransactionHash: log.transactionHash,
      },
    ]),
  );
  const expected: Expected[] = [];
  for (let height = 1; height <= upTo; height++) {
    const block = await node.getBlock(BlockNumber(height));
    if (!block) {
      throw new Error(`the node has no block ${height}`);
    }
    const archive = block.archive.root.toString().toLowerCase();
    expected.push({
      height,
      hash: block.hash.toString().toLowerCase(),
      archive,
      proposal: byArchive.get(archive),
    });
  }
  return expected;
};
