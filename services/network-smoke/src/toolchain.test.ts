import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLock, stagingDirs } from "./toolchain.js";

const SHA512 = `sha512-${"A".repeat(86)}==`;
const lock = (entry: Record<string, unknown>) =>
  JSON.stringify({
    packages: {
      "": { name: "toolchain" },
      "node_modules/a": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
        integrity: SHA512,
      },
      "node_modules/b": entry,
    },
  });

describe("toolchain lock check", () => {
  it("accepts entries with one sha512 and a registry.npmjs.org URL", () => {
    expect(() =>
      checkLock(
        lock({
          resolved: "https://registry.npmjs.org/b/-/b-1.0.0.tgz",
          integrity: SHA512,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an entry npm would install without a sha512 digest check", () => {
    expect(() =>
      checkLock(
        lock({
          resolved: "https://registry.npmjs.org/b/-/b-1.0.0.tgz",
          integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        }),
      ),
    ).toThrow("node_modules/b");
  });

  it("rejects an entry resolved outside registry.npmjs.org", () => {
    expect(() =>
      checkLock(
        lock({
          resolved: "https://example.com/b-1.0.0.tgz",
          integrity: SHA512,
        }),
      ),
    ).toThrow("node_modules/b");
  });
});

describe("toolchain staging directories", () => {
  it("finds only the given run's, never an install or another run's", () => {
    const dir = mkdtempSync(join(tmpdir(), "chicmoz-toolchain-"));
    try {
      const names = [
        "aztec-0123456789ab.tmp-ns0000000000",
        "aztec-0123456789ab.tmp-ns1111111111",
        "aztec-0123456789ab",
        "aztec-0123456789ab.tmp-ns0000000000x",
      ];
      for (const name of names) {
        mkdirSync(join(dir, name));
      }
      expect(stagingDirs(dir, "ns0000000000")).toEqual([join(dir, names[0])]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
