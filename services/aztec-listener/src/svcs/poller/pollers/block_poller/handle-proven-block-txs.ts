import { L2Block } from "@aztec-labs/aztec.js/block";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { ProtocolContractAddress } from "@aztec-labs/aztec.js/protocol";
import { type BlockHash } from "@aztec-labs/stdlib/block";
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash";
import { logger } from "../../../../logger.js";
import { txsController } from "../../../database/index.js";
import { publishMessage } from "../../../message-bus/index.js";

/** Reads a public storage slot as of `block`. */
export type ReadPublicStorage = (
  block: BlockHash,
  contract: AztecAddress,
  slot: Fr,
) => Promise<Fr>;

export type ProvenBlockOutcome = { ok: true } | { ok: false; error: Error };

type StoredTx = Awaited<ReturnType<typeof txsController.getTxs>>[number];

const BALANCE_FETCH_CONCURRENCY = 8;

// Maps each address to the first tx that names it (the event's sourceTxHash).
const collectUniqueAddresses = (txs: StoredTx[]): Map<string, string> => {
  const addressToTxHash = new Map<string, string>();

  for (const tx of txs) {
    const candidates: (string | null | undefined)[] = [
      tx.feePayer,
      tx.initiator,
      ...(tx.additionalMsgSenders ? tx.additionalMsgSenders.split(",") : []),
    ];

    for (const addr of candidates) {
      if (addr && !addressToTxHash.has(addr)) {
        addressToTxHash.set(addr, tx.txHash);
      }
    }
  }

  return addressToTxHash;
};

// The fee juice contract keeps balances in a map at storage slot 1.
const readFeeJuiceBalance = async (
  readStorage: ReadPublicStorage,
  block: BlockHash,
  address: AztecAddress,
) =>
  readStorage(
    block,
    ProtocolContractAddress.FeeJuice,
    await deriveStorageSlotInMap(new Fr(1), address),
  );

const fetchBalances = async (
  readStorage: ReadPublicStorage,
  block: BlockHash,
  addresses: string[],
) => {
  const balances = new Map<string, Fr>();
  let nextIndex = 0;
  // One failed read fails the block, so the other workers stop reading.
  let failed = false;
  await Promise.all(
    Array.from(
      { length: Math.min(BALANCE_FETCH_CONCURRENCY, addresses.length) },
      async () => {
        while (!failed && nextIndex < addresses.length) {
          const addr = addresses[nextIndex++];
          try {
            balances.set(
              addr,
              await readFeeJuiceBalance(
                readStorage,
                block,
                AztecAddress.fromStringUnsafe(addr),
              ),
            );
          } catch (e) {
            failed = true;
            throw e;
          }
        }
      },
    ),
  );
  return balances;
};

/**
 * Publishes the fee juice balance, as of `block`, of every address its stored
 * txs name, then marks those txs proven. It handles every stored tx of the
 * block, whatever its state, so a block run again after a prune or a proof
 * that moved back sends the same updates. Any failure fails the whole block.
 */
export const handleProvenTransactions = async (
  block: L2Block,
  readStorage: ReadPublicStorage,
): Promise<ProvenBlockOutcome> => {
  try {
    const hashes = block.body.txEffects.map((txEffect) =>
      txEffect.txHash.toString(),
    );
    const stored = new Map(
      (await txsController.getTxsByHashes(hashes)).map((tx) => [tx.txHash, tx]),
    );
    // In block order: an address's source tx is the block's first to name it.
    const txs = hashes.flatMap((hash) => stored.get(hash) ?? []);
    if (txs.length === 0) {
      return { ok: true };
    }
    const blockNumber = block.header.globalVariables.blockNumber.toString();
    const addressToTxHash = collectUniqueAddresses(txs);
    logger.info(
      `📋 Fetching fee-juice balances for ${addressToTxHash.size} addresses named by ${txs.length} txs in block ${blockNumber}`,
    );
    const balances = await fetchBalances(readStorage, await block.hash(), [
      ...addressToTxHash.keys(),
    ]);

    for (const [addr, sourceTxHash] of addressToTxHash) {
      const balance = balances.get(addr)?.toBigInt() ?? 0n;
      if (balance === 0n) {
        logger.debug(`⏭️ Skipping zero balance for ${addr}`);
        continue;
      }
      await publishMessage("CONTRACT_INSTANCE_BALANCE_EVENT", {
        contractAddress: addr,
        balance: balance.toString(),
        timestamp: new Date().getTime(),
        sourceTxHash,
        feeRecipient: block.header.globalVariables.feeRecipient.toString(),
        blockNumber,
      });
      logger.info(`💰 Snapshotted balance for ${addr}`);
    }

    for (const tx of txs) {
      await txsController.storeOrUpdateState(tx.txHash, "proven");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
};
