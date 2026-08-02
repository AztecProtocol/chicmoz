import { AztecAddress } from "@aztec/aztec.js/addresses";
import { loadContractArtifact } from "@aztec/aztec.js/abi";
import {
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import publicChecksArtifactJson from "@aztec/noir-contracts.js/artifacts/public_checks_contract-PublicChecks" with { type: "json" };
import { describe, expect, test } from "vitest";
import { generateVerifyInstancePayload } from "./generate-payload.js";
import { verifyInstanceDeploymentPayload } from "./verify-payload.js";

describe("v5 instance deployment verification", () => {
  test("verifies an official Aztec v5 contract instance", async () => {
    const artifact = loadContractArtifact(publicChecksArtifactJson);
    const contractClass = await getContractClassFromArtifact(artifact);
    const instance = await getContractInstanceFromInstantiationParams(artifact, {
      constructorArgs: [],
      deployer: AztecAddress.ZERO,
      salt: Fr.random(),
    });
    const payload = generateVerifyInstancePayload({
      publicKeysString: instance.publicKeys.toString(),
      deployer: instance.deployer.toString(),
      salt: instance.salt.toString(),
      constructorArgs: [],
    });

    await expect(
      verifyInstanceDeploymentPayload({
        ...payload,
        stringifiedArtifactJson: JSON.stringify(publicChecksArtifactJson),
        instanceAddress: instance.address.toString(),
        contractClassId: contractClass.id.toString(),
        immutablesHash: instance.immutablesHash.toString(),
      }),
    ).resolves.toBe(true);
  });

  test("rejects the current class id when it differs from the original class id", async () => {
    const artifact = loadContractArtifact(publicChecksArtifactJson);
    const instance = await getContractInstanceFromInstantiationParams(artifact, {
      constructorArgs: [],
      deployer: AztecAddress.ZERO,
      salt: Fr.random(),
    });
    const payload = generateVerifyInstancePayload({
      publicKeysString: instance.publicKeys.toString(),
      deployer: instance.deployer.toString(),
      salt: instance.salt.toString(),
      constructorArgs: [],
    });

    await expect(
      verifyInstanceDeploymentPayload({
        ...payload,
        stringifiedArtifactJson: JSON.stringify(publicChecksArtifactJson),
        instanceAddress: instance.address.toString(),
        contractClassId: Fr.ZERO.toString(),
        immutablesHash: instance.immutablesHash.toString(),
      }),
    ).resolves.toBe(false);
  });
});
