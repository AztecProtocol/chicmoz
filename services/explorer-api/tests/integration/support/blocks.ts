import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { EthAddress } from "@aztec-labs/foundation/eth-address";
import { Body, L2Block } from "@aztec-labs/stdlib/block";
import {
  BlockHeader,
  GlobalVariables,
  TxEffect,
  TxHash,
} from "@aztec-labs/stdlib/tx";
import { type HexString } from "@chicmoz-pkg/types";
import { listFixtures, loadFixture } from "@chicmoz/test-harness";

export type BuiltBlock = {
  hex: string;
  hash: HexString;
  height: bigint;
  txHashes: HexString[];
};

// A recorded effect with public logs and no contract-class logs, so storing a
// clone adds no contract rows that would collide across blocks.
const baseBlock = (): L2Block => {
  const fixture = listFixtures("local-network", "l2-block")
    .map((name) => loadFixture("local-network", "l2-block", name))
    .find(
      (f) =>
        f.data.expected.counts.publicLogs > 0 &&
        f.data.expected.counts.contractClassLogs === 0 &&
        f.data.expected.contractInstanceAddresses.length === 0,
    );
  if (!fixture) {
    throw new Error("no recorded local-network block with public logs and no contract logs");
  }
  return L2Block.fromBuffer(Buffer.from(fixture.data.hex, "hex"));
};

let base: L2Block | undefined;

/**
 * A block at `height` holding one clone of a recorded tx effect per entry of
 * `txHashes`, with a fresh random coinbase so every call has its own hash.
 * Its commitments do not match its body, which nothing on the handler's path
 * checks.
 */
export const buildBlock = async (
  height: bigint,
  txHashes: HexString[],
): Promise<BuiltBlock> => {
  base ??= baseBlock();
  const [effect] = base.body.txEffects;
  if (!effect) {
    throw new Error("base block has no tx effect");
  }
  const globals = GlobalVariables.from({
    ...base.header.globalVariables,
    blockNumber: BlockNumber(Number(height)),
    coinbase: EthAddress.random(),
  });
  const block = new L2Block(
    base.archive,
    BlockHeader.from({ ...base.header, globalVariables: globals }),
    new Body(
      txHashes.map((h) => TxEffect.from({ ...effect, txHash: TxHash.fromString(h) })),
    ),
    base.checkpointNumber,
    base.indexWithinCheckpoint,
  );
  const hex = Buffer.from(block.toBuffer() as Uint8Array).toString("hex");
  const decoded = L2Block.fromBuffer(Buffer.from(hex, "hex"));
  const built: BuiltBlock = {
    hex,
    hash: (await decoded.hash()).toString() ,
    height: BigInt(decoded.number),
    txHashes: decoded.body.txEffects.map((t) => t.txHash.toString() ),
  };
  if (built.height !== height || built.txHashes.join() !== txHashes.join()) {
    throw new Error(`built block does not round-trip: height ${built.height}, txs ${built.txHashes.join()}`);
  }
  return built;
};

/** A tx hash no recorded block or other call uses. */
export const freshTxHash = (): HexString => TxHash.random().toString() ;
