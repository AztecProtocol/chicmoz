import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { Fq, Fr } from "@aztec-labs/aztec.js/fields";
import { type AztecNode } from "@aztec-labs/aztec.js/node";
import { TxStatus } from "@aztec-labs/aztec.js/tx";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";

export type SentTx = { txHash: string; blockNumber: number };

/**
 * Deploys a fresh Schnorr account, paid by the local network's first funded
 * test account: one transaction the explorer has never seen.
 */
export const sendTx = async (node: AztecNode): Promise<SentTx> => {
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: false },
  });
  try {
    const [funded] = await getInitialTestAccountsData();
    const payer = await wallet.createSchnorrInitializerlessAccount(
      funded.secret,
      funded.salt,
      funded.signingKey,
    );
    const account = await wallet.createSchnorrAccount(
      Fr.random(),
      Fr.random(),
      Fq.random(),
    );
    const deploy = await account.getDeployMethod();
    // The wallet's default, PROPOSED, can return before the checkpoint
    // reaches L1, and the L1 oracle reads the rollup's logs once.
    const { receipt } = await deploy.send({
      from: payer.address,
      wait: { waitForStatus: TxStatus.CHECKPOINTED },
    });
    if (receipt.blockNumber === undefined) {
      throw new Error(`tx ${receipt.txHash.toString()} has no block number`);
    }
    return {
      txHash: receipt.txHash.toString().toLowerCase(),
      blockNumber: Number(receipt.blockNumber),
    };
  } finally {
    await wallet.stop();
  }
};
