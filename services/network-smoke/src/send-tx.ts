import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts";
import { Fq, Fr } from "@aztec-labs/aztec.js/fields";
import { type AztecNode } from "@aztec-labs/aztec.js/node";
import { TxStatus } from "@aztec-labs/aztec.js/tx";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";

export type SentTx = { txHash: string; blockNumber: number };

export type Sender = Awaited<ReturnType<typeof openSender>>;

/**
 * A wallet paying with the local network's first funded test account. Each
 * deployment is of a fresh Schnorr account: a transaction the explorer has
 * never seen, which also deploys a contract instance.
 */
export const openSender = async (node: AztecNode) => {
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
    const newAccount = async () => {
      const account = await wallet.createSchnorrAccount(
        Fr.random(),
        Fr.random(),
        Fq.random(),
      );
      return { account, deploy: await account.getDeployMethod() };
    };
    return {
      /**
       * One deployment that also publishes the account contract class, as
       * `deploy` needs: publishing an instance reads its class's nullifier.
       * Returns once the tx is checkpointed.
       */
      publishAccountClass: async () => {
        const { deploy } = await newAccount();
        await deploy.send({
          from: payer.address,
          skipClassPublication: false,
          skipInstancePublication: false,
          wait: { waitForStatus: TxStatus.CHECKPOINTED },
        });
      },
      /**
       * Publishes the instance too, which an account deployment skips by
       * default, so the explorer stores the contract. Needs the class
       * published (`publishAccountClass`). Returns once the node accepted
       * the tx.
       */
      deploy: async () => {
        const { account, deploy } = await newAccount();
        const { txHash } = await deploy.send({
          from: payer.address,
          skipInstancePublication: false,
          wait: NO_WAIT,
        });
        return {
          txHash: txHash.toString().toLowerCase(),
          address: account.address.toString().toLowerCase(),
        };
      },
      /** Returns once the tx is in a checkpoint on L1. */
      deployCheckpointed: async (): Promise<SentTx> => {
        const { deploy } = await newAccount();
        // The wallet's default, PROPOSED, can return before the checkpoint
        // reaches L1, and the L1 oracle reads the rollup's logs once.
        const { receipt } = await deploy.send({
          from: payer.address,
          wait: { waitForStatus: TxStatus.CHECKPOINTED },
        });
        if (receipt.blockNumber === undefined) {
          throw new Error(
            `tx ${receipt.txHash.toString()} has no block number`,
          );
        }
        return {
          txHash: receipt.txHash.toString().toLowerCase(),
          blockNumber: Number(receipt.blockNumber),
        };
      },
      stop: () => wallet.stop(),
    };
  } catch (e) {
    await wallet.stop();
    throw e;
  }
};

/** One checkpointed deployment through a wallet of its own. */
export const sendTx = async (node: AztecNode): Promise<SentTx> => {
  const sender = await openSender(node);
  try {
    return await sender.deployCheckpointed();
  } finally {
    await sender.stop();
  }
};
