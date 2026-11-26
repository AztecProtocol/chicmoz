import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PortClaimConflict,
  claimPorts,
  releasePorts,
} from "./port-registry.js";

// Another tool's rows and a line no parser expects: both must survive as they are.
const FOREIGN = [
  "# Ports registry — who is RUNNING what, where (atomic-locked)",
  "| port | service | owner (run) | worktree | pid-hint | claimed |",
  "|---|---|---|---|---|---|",
  "| 20248 | other-anvil | other-run | /elsewhere | 1 | 2026-11-26T00:00:00.000Z |",
  "  a note someone left  ",
  "",
].join("\n");

describe("port registry", () => {
  let dir: string;
  let file: string;
  const claim = (
    runId: string,
    ports: Record<string, number>,
    ownerPid = process.pid,
  ) => claimPorts({ runId, ports, ownerPid, worktree: "/repo" }, { file });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chicmoz-port-registry-"));
    file = join(dir, "ports.md");
    writeFileSync(file, FOREIGN);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds a run's rows, keeps every other line as it was, and releases only that run", async () => {
    await claim("ns1", { anvil: 21000, aztec: 21001 });
    await claim("ns2", { anvil: 21002 });
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines.slice(0, 5)).toEqual(FOREIGN.split("\n").slice(0, 5));
    expect(lines.filter((l) => l.includes("| chicmoz-smoke-"))).toHaveLength(3);

    await releasePorts("ns1", { file });
    await releasePorts("ns2", { file });
    expect(readFileSync(file, "utf8")).toBe(FOREIGN);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("refuses a port any line lists, writing nothing, and frees its own rows once their owner is dead", async () => {
    await expect(claim("ns1", { anvil: 20248 })).rejects.toThrow(
      PortClaimConflict,
    );
    expect(readFileSync(file, "utf8")).toBe(FOREIGN);

    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    await claim("ns1", { anvil: 21000 }, dead);
    await expect(claim("ns2", { anvil: 21000 })).resolves.toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toContain("| ns1 |");
  });

  it("waits for another writer's lock and never breaks it", async () => {
    writeFileSync(`${file}.lock`, "held by another tool\n");
    await expect(
      claimPorts(
        {
          runId: "ns1",
          ports: { anvil: 21000 },
          ownerPid: process.pid,
          worktree: "/repo",
        },
        { file, lockWaitMs: 300 },
      ),
    ).rejects.toThrow("stayed held");
    expect(readFileSync(`${file}.lock`, "utf8")).toBe("held by another tool\n");
    expect(readFileSync(file, "utf8")).toBe(FOREIGN);
  });
});
