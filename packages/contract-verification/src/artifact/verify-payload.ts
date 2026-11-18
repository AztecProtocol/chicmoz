import { type NoirCompiledContract } from "@aztec-labs/aztec.js/abi";
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { type ChicmozL2ContractClassRegisteredEvent } from "@chicmoz-pkg/types";
import { type VerifyArtifactPayload } from "../types.js";
import { loadArtifact, parseArtifactJson } from "./load-artifact.js";

export type ArtifactVerification =
  | {
      isMatchingClassId: true;
      artifactContractName: string;
      /** The upload re-serialized: the form to store. */
      artifactJson: string;
    }
  | {
      isMatchingClassId: false;
      reason: "NOT_COMPILER_OUTPUT" | "CLASS_ID_MISMATCH";
    };

const PRECOMPUTED_HASH_KEYS = [
  "artifactHash",
  "privateFunctionRoot",
  "utilityFunctionRoot",
  "metadataHash",
];

// The class id is computed from the artifact's fields only for raw compiler
// output: loadContractArtifact returns an already-loaded artifact (marked by
// nonDispatchPublicFunctions) as it is, and the compiler never writes
// precomputed hashes.
const isRawCompilerOutput = (
  value: unknown,
): value is NoirCompiledContract => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return (
    !Array.isArray(fields.nonDispatchPublicFunctions) &&
    PRECOMPUTED_HASH_KEYS.every((key) => !(key in fields))
  );
};

/**
 * Checks an uploaded artifact against a registered class by the full class
 * id. Throws the artifact refusal when the payload is not JSON, is over a
 * limit or the SDK cannot load it.
 */
export const verifyArtifactPayload = async (
  artifactPayload: VerifyArtifactPayload,
  registeredClass: Pick<
    ChicmozL2ContractClassRegisteredEvent,
    "contractClassId"
  >,
): Promise<ArtifactVerification> => {
  const parsed = parseArtifactJson(artifactPayload.stringifiedArtifactJson);
  if (!isRawCompilerOutput(parsed)) {
    return { isMatchingClassId: false, reason: "NOT_COMPILER_OUTPUT" };
  }
  const artifact = loadArtifact(parsed);
  const { id } = await getContractClassFromArtifact(artifact);
  if (!id.equals(Fr.fromString(registeredClass.contractClassId))) {
    return { isMatchingClassId: false, reason: "CLASS_ID_MISMATCH" };
  }
  return {
    isMatchingClassId: true,
    artifactContractName: artifact.name,
    artifactJson: JSON.stringify(parsed),
  };
};
