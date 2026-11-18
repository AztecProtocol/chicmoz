import {
  type ContractArtifact,
  loadContractArtifact,
  type NoirCompiledContract,
} from "@aztec-labs/aztec.js/abi";

// Every JSON value counts as a node; the root is at depth 1.
export const ARTIFACT_MAX_NODES = 120_000;
export const ARTIFACT_MAX_DEPTH = 64;
export const ARTIFACT_MAX_KEY_LENGTH = 128;

/** The one message every artifact refusal carries, whatever its cause. */
export const ARTIFACT_REFUSED_MESSAGE = "Invalid or oversized artifact";

const refusal = () => new Error(ARTIFACT_REFUSED_MESSAGE);

/** Throws the refusal when a parsed value is over a limit. */
export const checkArtifactShape = (root: unknown): void => {
  let nodes = 0;
  const containers: Array<{ value: object; depth: number }> = [];
  const visit = (value: unknown, depth: number) => {
    nodes += 1;
    if (nodes > ARTIFACT_MAX_NODES || depth > ARTIFACT_MAX_DEPTH) {
      throw refusal();
    }
    if (typeof value === "object" && value !== null) {
      containers.push({ value, depth });
    }
  };
  visit(root, 1);
  for (let next = containers.pop(); next; next = containers.pop()) {
    const { value, depth } = next;
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, depth + 1);
      }
      continue;
    }
    for (const key of Object.keys(value)) {
      if (key.length > ARTIFACT_MAX_KEY_LENGTH) {
        throw refusal();
      }
      visit((value as Record<string, unknown>)[key], depth + 1);
    }
  }
};

/** Parses artifact JSON; throws the refusal when it is not JSON. */
export const parseArtifactJson = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw refusal();
  }
};

// The SDK's own messages can quote the input, so they are dropped.
const loadParsed = (parsed: unknown): ContractArtifact => {
  try {
    return loadContractArtifact(parsed as NoirCompiledContract);
  } catch {
    throw refusal();
  }
};

/** Checks a parsed artifact's shape and loads it with the SDK; throws only the refusal. */
export const loadArtifact = (parsed: unknown): ContractArtifact => {
  checkArtifactShape(parsed);
  return loadParsed(parsed);
};

/** Parses, checks and loads artifact JSON; throws only the refusal. */
export const loadArtifactJson = (json: string): ContractArtifact =>
  loadArtifact(parseArtifactJson(json));

/**
 * `loadArtifactJson` without the shape check, for stored JSON or an upload that
 * has already passed it: JSON stored before the limits can be over them and
 * still load.
 */
export const loadStoredArtifactJson = (json: string): ContractArtifact =>
  loadParsed(parseArtifactJson(json));
