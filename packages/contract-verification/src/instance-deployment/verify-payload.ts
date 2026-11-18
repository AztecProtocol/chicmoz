import { getDefaultInitializer } from "@aztec-labs/stdlib/abi";
import {
  computeContractAddressFromInstance,
  computeInitializationHash,
  computeSaltedInitializationHash,
} from "@aztec-labs/stdlib/contract";
import { loadStoredArtifactJson } from "../artifact/load-artifact.js";
import { VerifyInstanceDeploymentPayload } from "../types.js";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { PublicKeys } from "@aztec-labs/aztec.js/keys";

/** `stringifiedArtifactJson` is stored JSON or an upload already checked by `loadArtifactJson`. */
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
  const artifact = loadStoredArtifactJson(stringifiedArtifactJson);

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
