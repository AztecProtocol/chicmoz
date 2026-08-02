import { PublicChecksContract } from "@aztec/noir-contracts.js/PublicChecks";
import * as contractArtifactJson from "@aztec/noir-contracts.js/artifacts/public_checks_contract-PublicChecks" with { type: "json" };
import { logger } from "../../logger.js";
import { getAccounts, getAztecNodeClient, getWallet } from "../pxe.js";
import {
  deployContract,
  registerContractClassArtifact,
  verifyContractInstanceDeployment,
} from "./utils/index.js";

const contractId = "V5PublicChecksReference";

export async function run() {
  logger.info(`===== ${contractId} =====`);
  const wallet = getWallet();
  const deployer = getAccounts().alice.address;
  const { contract, instance } = await deployContract({
    contractLoggingName: contractId,
    deployFn: () => PublicChecksContract.deploy(wallet),
    from: deployer,
    node: getAztecNodeClient(),
  });

  await registerContractClassArtifact(
    contractId,
    contractArtifactJson,
    instance.originalContractClassId.toString(),
    instance.version,
    { throwOnError: true },
  );
  await verifyContractInstanceDeployment({
    contractLoggingName: contractId,
    contractInstanceAddress: contract.address.toString(),
    verifyArgs: {
      publicKeysString: instance.publicKeys.toString(),
      deployer: instance.deployer.toString(),
      salt: instance.salt.toString(),
      constructorArgs: [],
    },
    throwOnError: true,
  });

  logger.info(
    `✅ Verified official Aztec v5 reference contract ${contract.address.toString()}`,
  );
}
