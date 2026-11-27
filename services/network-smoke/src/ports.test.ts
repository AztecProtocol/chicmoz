import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimRunPorts,
  freePorts,
  parseEphemeralFloor,
  parsePorts,
  portBelow,
} from "./ports.js";

describe("ports", () => {
  it("refuses a fixed port that a process outside the registry holds, and claims none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chicmoz-ports-"));
    const file = join(dir, "ports.md");
    const fixed = await freePorts();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(fixed.aztec, resolve));
    try {
      await expect(
        claimRunPorts(
          {
            runId: "ns0000000000",
            ownerPid: process.pid,
            worktree: dir,
            fixed,
          },
          { file },
        ),
      ).rejects.toThrow(`fixed port ${fixed.aztec} (aztec) is in use`);
      expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain(
        "ns0000000000",
      );
    } finally {
      await new Promise((resolve) => holder.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a websocket health port that is not ws + 1", () => {
    expect(() =>
      parsePorts("20001,20002,20003,20004,20005,20006,20008"),
    ).toThrow("wsHealth must be ws + 1");
  });

  it("rejects a port given twice", () => {
    expect(() =>
      parsePorts("20001,20001,20003,20004,20005,20006,20007"),
    ).toThrow("distinct");
  });

  it("reads the ephemeral floor, and ignores one that leaves no room below it", () => {
    expect(parseEphemeralFloor("32768\t60999\n")).toBe(32768);
    expect(parseEphemeralFloor("10005\t60999\n")).toBeUndefined();
  });

  it("keeps every port of a span inside 10000 and below the floor", () => {
    expect(portBelow(32768, 2, () => 0)).toBe(10_000);
    // The highest draw leaves room for ws + 1 below the floor.
    expect(portBelow(32768, 2, () => 0.999_999_9)).toBe(32766);
  });
});
