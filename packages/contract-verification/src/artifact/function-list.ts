import {
  type ABIParameter,
  type AbiType,
  type NoirCompiledContract,
} from "@aztec-labs/aztec.js/abi";
import {
  AZTEC_PRIVATE_ATTRIBUTE,
  AZTEC_PUBLIC_ATTRIBUTE,
} from "@aztec-labs/stdlib/noir";
import { isDeepStrictEqual } from "node:util";

type NoirFunction = NoirCompiledContract["functions"][number];
type StructType = Extract<AbiType, { kind: "struct" }>;

// Compiler-added public functions that have no ABI struct in `outputs`.
const PARAMETERS_WITHOUT_OUTPUTS_ENTRY = new Map<string, ABIParameter[]>([
  [
    "public_dispatch",
    [{ name: "selector", type: { kind: "field" }, visibility: "private" }],
  ],
  ["__emit_public_init_nullifier", []],
]);

const isPrivate = (fn: NoirFunction) =>
  fn.custom_attributes.includes(AZTEC_PRIVATE_ATTRIBUTE);

const isPublic = (fn: NoirFunction) =>
  !isPrivate(fn) && fn.custom_attributes.includes(AZTEC_PUBLIC_ATTRIBUTE);

// The parameters as loadContractArtifact shows them: it drops a first
// `*ContextInputs` struct, which the compiler adds to private functions.
const shownParameters = ({ abi: { parameters } }: NoirFunction) => {
  const [first] = parameters;
  return first?.type.kind === "struct" &&
    first.type.path.includes("ContextInputs")
    ? parameters.slice(1)
    : parameters;
};

const fieldType = (entry: StructType, name: string) =>
  entry.fields.find((field) => field.name === name)?.type;

const hasNoReturnType = (fn: NoirFunction) =>
  (fn.abi.return_type ?? null) === null;

const matchesEntry = (fn: NoirFunction, entry: StructType) => {
  const compiled = fieldType(entry, "parameters");
  if (compiled?.kind !== "struct") {
    return false;
  }
  const shown = shownParameters(fn);
  const { fields } = compiled;
  if (
    shown.length !== fields.length ||
    !shown.every((param, i) => isDeepStrictEqual(param.type, fields[i].type))
  ) {
    return false;
  }
  // Some compiler output writes every label of a function in `outputs` with
  // a leading underscore.
  const labelsMatch =
    shown.every((param, i) => fields[i].name === param.name) ||
    shown.every((param, i) => fields[i].name === `_${param.name}`);
  if (!labelsMatch) {
    return false;
  }
  // A private function's raw return type is the circuit's public inputs; the
  // loader takes the declared one from `outputs`.
  if (isPrivate(fn)) {
    return true;
  }
  const declared = fieldType(entry, "return_type");
  return declared === undefined
    ? hasNoReturnType(fn)
    : isDeepStrictEqual(declared, fn.abi.return_type?.abi_type);
};

const matchesPinned = (fn: NoirFunction, parameters: ABIParameter[]) =>
  isPublic(fn) &&
  hasNoReturnType(fn) &&
  isDeepStrictEqual(fn.abi.parameters, parameters);

/**
 * True when `functions` agrees with the per-function ABI structs in
 * `outputs`, which the class id covers: one struct per function and one
 * function per struct, with equal parameter names, order and types and equal
 * public and utility return types. Expects compiler output that
 * `loadArtifact` has accepted.
 */
export const isFunctionListBoundToOutputs = (
  artifact: NoirCompiledContract,
): boolean => {
  const entries = new Map<string, StructType>();
  for (const entry of artifact.outputs.structs.functions ?? []) {
    if (entry.kind !== "struct" || entries.has(entry.path)) {
      return false;
    }
    entries.set(entry.path, entry);
  }
  const names = new Set<string>();
  for (const fn of artifact.functions) {
    if (names.has(fn.name)) {
      return false;
    }
    names.add(fn.name);
    const entry = entries.get(`${artifact.name}::${fn.name}_abi`);
    const pinned = PARAMETERS_WITHOUT_OUTPUTS_ENTRY.get(fn.name);
    const matches =
      pinned !== undefined
        ? entry === undefined && matchesPinned(fn, pinned)
        : entry !== undefined && matchesEntry(fn, entry);
    if (!matches) {
      return false;
    }
  }
  const functionsWithEntry = artifact.functions.filter(
    (fn) => !PARAMETERS_WITHOUT_OUTPUTS_ENTRY.has(fn.name),
  );
  return entries.size === functionsWithEntry.length;
};
