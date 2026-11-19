import { BSON } from "bson";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../repo.js";
import { FIXTURES_DIR, MAX_FIXTURE_BYTES } from "../fixtures/index.js";
import {
  FIXTURE_DATA_SCHEMAS,
  FIXTURE_FORMAT,
  fromTagged,
  toTagged,
  type FixtureData,
  type FixtureFeature,
  type FixtureKind,
  type FixtureSource,
} from "../fixtures/format.js";
import { findLeaks, sanitize } from "../fixtures/sanitize.js";

// Never written anywhere: only checked against, so a recording cannot carry this machine's identity.
const MACHINE_IDENTITY = [hostname(), userInfo().username, homedir(), REPO_ROOT].filter(
  (id) => id.length >= 4,
);

export type FixtureToWrite<K extends FixtureKind> = {
  source: FixtureSource;
  kind: K;
  name: string;
  aztecVersion: string;
  origin: string;
  features: FixtureFeature[];
  data: FixtureData[K];
};

/**
 * Sanitizes, validates and writes one fixture. Refuses to write when the
 * sanitized file would still fail the committed leak guard.
 */
export const writeFixture = <K extends FixtureKind>(
  f: FixtureToWrite<K>,
): string => {
  const envelope = {
    format: FIXTURE_FORMAT,
    kind: f.kind,
    source: f.source,
    aztecVersion: f.aztecVersion,
    recordedAt: new Date().toISOString(),
    origin: f.origin,
    features: [...new Set(f.features)].sort(),
    data: toTagged(sanitize(f.data)),
  };
  // A frame's bytes must stay exact, so a leak inside them rejects the frame rather than being redacted.
  const decodedFrame =
    f.kind === "frame"
      ? findLeaks(
          toTagged(BSON.deserialize(new Uint8Array(Buffer.from((f.data as FixtureData["frame"]).bson, "hex")))),
          "$.data.bson",
          MACHINE_IDENTITY,
        )
      : [];
  const leaks = [...findLeaks(envelope, "$", MACHINE_IDENTITY), ...decodedFrame];
  if (leaks.length > 0) {
    throw new Error(
      `refusing to write ${f.source}/${f.kind}/${f.name}: ${leaks.map((l) => `${l.path} ${l.reason}`).join("; ")}`,
    );
  }
  FIXTURE_DATA_SCHEMAS[f.kind].parse(fromTagged(envelope.data));
  const dir = join(FIXTURES_DIR, f.source, f.kind);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${f.name}.json`);
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_FIXTURE_BYTES) {
    throw new Error(`refusing to write ${f.source}/${f.kind}/${f.name}: over ${MAX_FIXTURE_BYTES} bytes`);
  }
  writeFileSync(path, text);
  return path;
};
