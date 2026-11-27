import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimPorts } from "./port-registry.js";

// The lock's token is its only writeSync.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  writeSync: () => {
    throw Object.assign(new Error("no space left on device"), {
      code: "ENOSPC",
    });
  },
}));

describe("port registry lock", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "chicmoz-port-lock-"));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("removes a lock it created when its token cannot be written", async () => {
    const file = join(dir, "ports.md");
    await expect(
      claimPorts(
        {
          runId: "ns0000000000",
          ports: { anvil: 20_001 },
          ownerPid: process.pid,
          worktree: dir,
        },
        { file, lockWaitMs: 1_000 },
      ),
    ).rejects.toThrow("no space left on device");
    expect(fs.existsSync(`${file}.lock`), "the lock file").toBe(false);
  });
});
