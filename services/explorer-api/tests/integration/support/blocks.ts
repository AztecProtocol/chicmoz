import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
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
 * The coinbase is salted to tell headers at one height apart. The handler
 * does not recompute the body's commitments, so cloned effects are accepted.
 * `version` replaces the recorded rollup version.
 */
export const buildBlock = async (
  height: bigint,
  txHashes: HexString[],
  { version }: { version?: number } = {},
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
    ...(version === undefined ? {} : { version: new Fr(version) }),
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
    hash: (await decoded.hash()).toString(),
    height: BigInt(decoded.number),
    txHashes: decoded.body.txEffects.map((t) => t.txHash.toString()),
  };
  if (built.height !== height || built.txHashes.join() !== txHashes.join()) {
    throw new Error(`built block does not round-trip: height ${built.height}, txs ${built.txHashes.join()}`);
  }
  return built;
};

export const freshTxHash = (): HexString => TxHash.random().toString();
