import {
  type AbiType,
  type ContractArtifact,
  encodeArguments,
  type FunctionAbi,
  FunctionSelector,
  FunctionType,
  getAllFunctionAbis,
  getDefaultInitializer,
} from "@aztec-labs/stdlib/abi";
import {
  computeContractAddressFromInstance,
  computeInitializationHashFromEncodedArgs,
  computeSaltedInitializationHash,
} from "@aztec-labs/stdlib/contract";
import { CONSTRUCTOR_ARGS_MAX } from "@chicmoz-pkg/types";
import { loadStoredArtifactJson } from "../artifact/load-artifact.js";
import { VerifyInstanceDeploymentPayload } from "../types.js";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { PublicKeys } from "@aztec-labs/aztec.js/keys";

export type InstanceDeploymentVerification =
  | {
      isVerified: true;
      /** The function the instance was initialized with; null when it has none. */
      initializer: string | null;
    }
  | {
      isVerified: false;
      /** Set when a search limit ended the search before every candidate was tried. */
      stoppedAt?: {
        limit: SearchLimit;
        candidatesExamined: number;
        encodedFields: number;
      };
    };

type SearchLimit = "argumentLength" | "candidates" | "encodedFields";

// A registered class can carry many functions that cost nothing on chain, so
// one search examines at most this many candidates and encodes at most this
// many fields in total. An honest deployment matches its first candidate
// unless the stored marker was changed or a non-default initializer was used.
const MAX_INITIALIZER_CANDIDATES = 256;
const MAX_INITIALIZER_SEARCH_FIELDS = 65_536;

// Every candidate parses the arguments again, and no argument a candidate can
// accept needs more characters: a field or an integer takes at most 66 hex or
// 78 decimal characters, a string at most `CONSTRUCTOR_ARGS_MAX`.
const MAX_CONSTRUCTOR_ARGUMENT_LENGTH = 8_192;

type InitializerSearchLimits = {
  candidates: number;
  encodedFields: number;
};

const DEFAULT_SEARCH_LIMITS: InitializerSearchLimits = {
  candidates: MAX_INITIALIZER_CANDIDATES,
  encodedFields: MAX_INITIALIZER_SEARCH_FIELDS,
};

// The class id does not cover the initializer marker, so the marker only
// orders the candidates and the instance address decides which one was used.
const initializerCandidates = (artifact: ContractArtifact): FunctionAbi[] => {
  const functions = getAllFunctionAbis(artifact);
  const defaultInitializer = getDefaultInitializer(artifact);
  const otherInitializers = functions.filter(
    (fn) => fn.isInitializer && fn !== defaultInitializer,
  );
  const otherFunctions = functions.filter(
    (fn) =>
      !fn.isInitializer &&
      fn.functionType !== FunctionType.UTILITY &&
      fn.name !== "public_dispatch",
  );
  return [
    ...(defaultInitializer ? [defaultInitializer] : []),
    ...otherInitializers,
    ...otherFunctions,
  ];
};

// An integer wider than a field element cannot be one argument field.
const MAX_INTEGER_WIDTH = 254;

// A declared length or width that is not a whole number counts as unbounded,
// so it can neither pass a limit nor lower a running total.
const dimension = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 ? value : Infinity;

// An upper bound on the fields the SDK encoder allocates for a type: one per
// declared string character and array element, and at least one per struct,
// since the encoder writes a struct it recognizes by path (an address or a
// selector) as one field whatever fields it declares. The encoder also builds
// an integer of `width` bits for each integer parameter.
const encodedFieldCount = (type: AbiType): number => {
  switch (type.kind) {
    case "integer":
      return dimension(type.width) <= MAX_INTEGER_WIDTH ? 1 : Infinity;
    case "string":
      return dimension(type.length);
    case "array":
      return dimension(type.length) * encodedFieldCount(type.type);
    case "struct":
      return Math.max(
        1,
        type.fields.reduce(
          (sum, field) => sum + encodedFieldCount(field.type),
          0,
        ),
      );
    case "tuple":
      return type.fields.reduce(
        (sum, field) => sum + encodedFieldCount(field),
        0,
      );
    default:
      return 1;
  }
};

// Infinity when the parameter types cannot be measured (`0 * Infinity` is NaN).
const encodedFieldsOf = (fn: FunctionAbi) => {
  try {
    const fields = fn.parameters.reduce(
      (sum, parameter) => sum + encodedFieldCount(parameter.type),
      0,
    );
    return Number.isNaN(fields) ? Infinity : fields;
  } catch {
    return Infinity;
  }
};

// Undefined when the arguments do not encode for this function.
const encodedArgumentsOf = (fn: FunctionAbi, args: string[]) => {
  try {
    return encodeArguments(fn, args);
  } catch {
    return undefined;
  }
};

/**
 * Finds the function whose initialization with `constructorArgs` leads to the
 * instance address. Only functions with as many parameters as there are
 * arguments are candidates. A candidate whose parameters encode to more than
 * `CONSTRUCTOR_ARGS_MAX` fields, or that has an integer wider than a field, is
 * skipped. The search ends unverified, with `stoppedAt` set, once it would
 * pass `limits`, and before any candidate when an argument is longer than
 * `MAX_CONSTRUCTOR_ARGUMENT_LENGTH` characters. An instance without an
 * initializer matches only empty `constructorArgs` and is checked before the
 * search, so no limit blocks it. `stringifiedArtifactJson` is stored JSON or an
 * upload already checked by `loadArtifactJson`.
 */
export const verifyInstanceDeploymentPayload = async (
  payload: VerifyInstanceDeploymentPayload & {
    instanceAddress: string;
    stringifiedArtifactJson: string;
    contractClassId: string;
    immutablesHash: string;
  },
  limits: InitializerSearchLimits = DEFAULT_SEARCH_LIMITS,
): Promise<InstanceDeploymentVerification> => {
  const { stringifiedArtifactJson, constructorArgs } = payload;
  let candidatesExamined = 0;
  let encodedFields = 0;
  const stopAt = (limit: SearchLimit): InstanceDeploymentVerification => ({
    isVerified: false,
    stoppedAt: { limit, candidatesExamined, encodedFields },
  });
  if (
    constructorArgs.some((arg) => arg.length > MAX_CONSTRUCTOR_ARGUMENT_LENGTH)
  ) {
    return stopAt("argumentLength");
  }

  const artifact = loadStoredArtifactJson(stringifiedArtifactJson);
  const salt = Fr.fromString(payload.salt);
  const deployer = AztecAddress.fromStringUnsafe(payload.deployer);
  const immutablesHash = Fr.fromString(payload.immutablesHash);
  const originalContractClassId = Fr.fromString(payload.contractClassId);
  const publicKeys = PublicKeys.fromString(payload.publicKeysString);

  const leadsToInstance = async (initializationHash: Fr) => {
    const saltedInitializationHash = await computeSaltedInitializationHash({
      initializationHash,
      salt,
      deployer,
      immutablesHash,
    });
    const address = await computeContractAddressFromInstance({
      originalContractClassId,
      saltedInitializationHash,
      publicKeys,
    });
    return address.toString() === payload.instanceAddress;
  };

  if (constructorArgs.length === 0 && (await leadsToInstance(Fr.ZERO))) {
    return { isVerified: true, initializer: null };
  }

  const candidates = initializerCandidates(artifact).filter(
    (fn) => fn.parameters.length === constructorArgs.length,
  );
  for (const fn of candidates) {
    if (candidatesExamined === limits.candidates) {
      return stopAt("candidates");
    }
    candidatesExamined += 1;
    const fields = encodedFieldsOf(fn);
    if (fields > CONSTRUCTOR_ARGS_MAX) {
      continue;
    }
    if (fields > limits.encodedFields - encodedFields) {
      return stopAt("encodedFields");
    }
    encodedFields += fields;
    const encodedArgs = encodedArgumentsOf(fn, constructorArgs);
    if (encodedArgs === undefined) {
      continue;
    }
    const selector = await FunctionSelector.fromNameAndParameters(
      fn.name,
      fn.parameters,
    );
    const initializationHash = await computeInitializationHashFromEncodedArgs(
      selector,
      encodedArgs,
    );
    if (await leadsToInstance(initializationHash)) {
      return { isVerified: true, initializer: fn.name };
    }
  }
  return { isVerified: false };
};
