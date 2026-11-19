import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_DATA_SCHEMAS,
  FIXTURE_NAME,
  fixtureEnvelopeSchema,
  fromTagged,
  type Fixture,
  type FixtureKind,
  type FixtureSource,
} from "./format.js";

export {
  FIXTURE_KINDS,
  FIXTURE_SOURCES,
  type Fixture,
  type FixtureData,
  type FixtureFeature,
  type FixtureKind,
  type FixtureSource,
} from "./format.js";

/** `packages/test-harness/fixtures/`; this module sits two levels below the package in `src/` and `build/`. */
export const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));

export const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;

const kindDir = (source: FixtureSource, kind: FixtureKind) =>
  join(FIXTURES_DIR, source, kind);

/** Fixture names (file names without `.json`) of one source and kind, sorted. Throws when the directory is missing or empty, so a typo cannot pass as an empty corpus. */
export const listFixtures = (
  source: FixtureSource,
  kind: FixtureKind,
): string[] => {
  const names = readdirSync(kindDir(source, kind))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
  if (names.length === 0) {
    throw new Error(`no fixtures in ${source}/${kind}`);
  }
  return names;
};

/** Reads a fixture file as the raw envelope JSON, with no validation. */
export const readFixtureFile = (path: string): unknown => {
  if (statSync(path).size > MAX_FIXTURE_BYTES) {
    throw new Error(`${path} exceeds ${MAX_FIXTURE_BYTES} bytes`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
};

/**
 * Loads one fixture: validates the envelope and the kind's `data`, and
 * revives tagged values (bigint, bytes, Date). Throws when the file's `kind`
 * or `source` differs from its directory.
 */
export const loadFixture = <K extends FixtureKind>(
  source: FixtureSource,
  kind: K,
  name: string,
): Fixture<K> => {
  if (!FIXTURE_NAME.test(name)) {
    throw new Error(`fixture names are lowercase words joined by "-"; got one that is not`);
  }
  const path = join(kindDir(source, kind), `${name}.json`);
  const envelope = fixtureEnvelopeSchema.parse(readFixtureFile(path));
  if (envelope.kind !== kind || envelope.source !== source) {
    throw new Error(
      `${path} declares ${envelope.source}/${envelope.kind}, expected ${source}/${kind}`,
    );
  }
  const data = FIXTURE_DATA_SCHEMAS[kind].parse(
    fromTagged(envelope.data),
  ) as Fixture<K>["data"];
  return { ...envelope, kind, data };
};

/** The Kafka message value of a `frame` fixture, ready for `BSON.deserialize`. */
export const frameBytes = (fixture: Fixture<"frame">): Uint8Array =>
  new Uint8Array(Buffer.from(fixture.data.bson, "hex"));
