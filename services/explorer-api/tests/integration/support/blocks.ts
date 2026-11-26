import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { EthAddress } from "@aztec-labs/foundation/eth-address";
import { Body, L2Block } from "@aztec-labs/stdlib/block";
import { AppendOnlyTreeSnapshot } from "@aztec-labs/stdlib/trees";
import {
  BlockHeader,
  GlobalVariables,
  TxEffect,
  TxHash,
} from "@aztec-labs/stdlib/tx";
import {
  type CatchupBlockEvent,
  type NewBlockEvent,
} from "@chicmoz-pkg/message-registry";
import { type HexString } from "@chicmoz-pkg/types";
import { listFixtures, loadFixture } from "@chicmoz/test-harness";

export type BuiltBlock = {
  hex: string;
  hash: HexString;
  height: bigint;
  txHashes: HexString[];
  archive: AppendOnlyTreeSnapshot;
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
 * `version` replaces the recorded rollup version. Each block gets an archive
 * of its own, unless `archive` names one; `parent` makes the block's last
 * archive the parent's archive, the link a chain's consecutive blocks have.
 */
export const buildBlock = async (
  height: bigint,
  txHashes: HexString[],
  {
    version,
    parent,
    archive: sharedArchive,
  }: {
    version?: number;
    parent?: Pick<BuiltBlock, "archive">;
    archive?: AppendOnlyTreeSnapshot;
  } = {},
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
  const archive =
    sharedArchive ??
    new AppendOnlyTreeSnapshot(Fr.random(), base.archive.nextAvailableLeafIndex);
  const block = new L2Block(
    archive,
    BlockHeader.from({
      ...base.header,
      ...(parent ? { lastArchive: parent.archive } : {}),
      globalVariables: globals,
    }),
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
    archive: decoded.archive,
  };
  if (built.height !== height || built.txHashes.join() !== txHashes.join()) {
    throw new Error(`built block does not round-trip: height ${built.height}, txs ${built.txHashes.join()}`);
  }
  return built;
};

export const freshTxHash = (): HexString => TxHash.random().toString();

/** `count` linked blocks from `from` up, one fresh tx each; the first links to `parent`. */
export const buildChain = async (
  from: bigint,
  count: number,
  {
    version,
    parent,
  }: { version?: number; parent?: Pick<BuiltBlock, "archive"> } = {},
): Promise<BuiltBlock[]> => {
  const chain: BuiltBlock[] = [];
  for (let i = 0; i < count; i++) {
    chain.push(
      await buildBlock(from + BigInt(i), [freshTxHash()], {
        version,
        parent: chain[i - 1] ?? parent,
      }),
    );
  }
  return chain;
};

/** As the hash-following listener sends it: `tip` defaults to the block's own height. */
export const orderedEvent = (
  b: BuiltBlock,
  tip = Number(b.height),
): NewBlockEvent => ({
  block: b.hex,
  blockNumber: Number(b.height),
  statusHint: "proposed",
  ordered: { tip },
});

export const catchupEvent = (
  b: BuiltBlock,
  { final }: { final?: true } = {},
): CatchupBlockEvent => ({
  block: b.hex,
  blockNumber: Number(b.height),
  statusHint: "proposed",
  ...(final ? { final } : {}),
});
