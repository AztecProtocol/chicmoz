import { getDefaultInitializer, loadContractArtifact } from "@aztec-labs/stdlib/abi";
import {
  computeContractAddressFromInstance,
  computeInitializationHash,
  computeSaltedInitializationHash,
} from "@aztec-labs/stdlib/contract";
import { VerifyInstanceDeploymentPayload } from "../types.js";
import { NoirCompiledContract } from "@aztec-labs/aztec.js/abi";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { PublicKeys } from "@aztec-labs/aztec.js/keys";

export const verifyInstanceDeploymentPayload = async (
  payload: VerifyInstanceDeploymentPayload & {
    instanceAddress: string;
    stringifiedArtifactJson: string;
    contractClassId: string;
    immutablesHash: string;
  },
): Promise<boolean> => {
  const {
    stringifiedArtifactJson,
    contractClassId,
    constructorArgs,
    deployer,
    immutablesHash,
    salt,
    publicKeysString,
  } = payload;
  const artifact = loadContractArtifact(
    JSON.parse(stringifiedArtifactJson) as unknown as NoirCompiledContract,
  );

  const initFn = getDefaultInitializer(artifact);
  const initializationHash = await computeInitializationHash(
    initFn,
    constructorArgs,
  );
  const saltedHash = await computeSaltedInitializationHash({
    initializationHash,
    salt: Fr.fromString(salt),
    deployer: AztecAddress.fromStringUnsafe(deployer),
    immutablesHash: Fr.fromString(immutablesHash),
  });
  const computedAddress = await computeContractAddressFromInstance({
    originalContractClassId: Fr.fromString(contractClassId),
    saltedInitializationHash: saltedHash,
    publicKeys: PublicKeys.fromString(publicKeysString),
  });
  return computedAddress.toString() === payload.instanceAddress;
};
