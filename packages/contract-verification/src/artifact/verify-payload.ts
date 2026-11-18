import { type NoirCompiledContract } from "@aztec-labs/aztec.js/abi";
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { type ChicmozL2ContractClassRegisteredEvent } from "@chicmoz-pkg/types";
import { type VerifyArtifactPayload } from "../types.js";
import { isFunctionListBoundToOutputs } from "./function-list.js";
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
      reason:
        | "NOT_COMPILER_OUTPUT"
        | "CLASS_ID_MISMATCH"
        | "FUNCTION_LIST_MISMATCH";
    };

const PRECOMPUTED_HASH_KEYS = [
  "artifactHash",
  "privateFunctionRoot",
  "utilityFunctionRoot",
  "metadataHash",
];

const hasLoadedFunctionType = (functions: unknown) =>
  Array.isArray(functions) &&
  functions.some(
    (fn: unknown) =>
      typeof fn === "object" &&
      fn !== null &&
      Object.hasOwn(fn, "functionType"),
  );

// The class id is computed from the artifact's fields only for raw compiler
// output: loadContractArtifact returns an already-loaded artifact (marked by
// nonDispatchPublicFunctions) as it is, and the compiler never writes
// precomputed hashes. Nor does it write a function's functionType, which the
// loader prefers over the function's attributes when it sorts out public
// functions.
const isRawCompilerOutput = (
  value: unknown,
): value is NoirCompiledContract => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return (
    !Array.isArray(fields.nonDispatchPublicFunctions) &&
    PRECOMPUTED_HASH_KEYS.every((key) => !(key in fields)) &&
    !hasLoadedFunctionType(fields.functions)
  );
};

/**
 * Checks an uploaded artifact against a registered class by the full class
 * id, then checks its function list against its `outputs`. Throws the
 * artifact refusal when the payload is not JSON, is over a limit or the SDK
 * cannot load it.
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
  if (!isFunctionListBoundToOutputs(parsed)) {
    return { isMatchingClassId: false, reason: "FUNCTION_LIST_MISMATCH" };
  }
  return {
    isMatchingClassId: true,
    artifactContractName: artifact.name,
    artifactJson: JSON.stringify(parsed),
  };
};
