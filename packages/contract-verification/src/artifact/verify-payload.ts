import { ChicmozL2ContractClassRegisteredEvent } from "@chicmoz-pkg/types";
import { VerifyArtifactPayload } from "../types.js";
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts";
import { loadArtifactJson } from "./load-artifact.js";

export type VerificationResult = {
  isMatchingByteCode: boolean;
  artifactContractName: string;
};

export const verifyArtifactPayload = async (
  artifactPayload: VerifyArtifactPayload,
  storedArtifact: ChicmozL2ContractClassRegisteredEvent,
): Promise<VerificationResult> => {
  const loadedArtifact = loadArtifactJson(
    artifactPayload.stringifiedArtifactJson,
  );
  const contractClass = await getContractClassFromArtifact(loadedArtifact);
  const storedBytes = Uint8Array.from(storedArtifact.packedBytecode);
  const contractBytes = Uint8Array.from(contractClass.packedBytecode);
  const isMatchingByteCode =
    storedBytes.length === contractBytes.length &&
    storedBytes.every((value, index) => value === contractBytes[index]);
  return {
    isMatchingByteCode,
    artifactContractName: loadedArtifact.name,
  };
};
