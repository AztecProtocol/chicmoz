import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Client for the host's port registry, `~/.agents/ports.md`, which every
 * agent on the host reads to see which ports another run holds. Other tools
 * write the same file, so its format and lock are a contract matched here:
 * rows `| port | service | owner (run) | worktree | pid-hint | claimed |`,
 * rewritten only while `<file>.lock` exists, created with `open(..., "wx")`.
 * Some writers delete a lock older than 15 s; this client never breaks one
 * (a breaker can delete a lock taken after it judged the old one stale), and
 * fails closed after waiting longer. Only rows with this prefix are parsed
 * whole or dropped; every other line is copied byte for byte, and every port
 * any line lists counts as taken.
 */
export const SERVICE_PREFIX = "chicmoz-smoke-";

const HEADER = [
  "# Ports registry — who is RUNNING what, where (atomic-locked)",
  "| port | service | owner (run) | worktree | pid-hint | claimed |",
  "|---|---|---|---|---|---|",
];
// Linux's ceiling for pid_max: a larger hint names no process.
const PID_MAX = 4_194_304;

export type RegistryOptions = {
  /** Defaults to `~/.agents/ports.md`. */
  file?: string;
  lockWaitMs?: number;
};

const pathOf = ({ file }: RegistryOptions) =>
  file ?? join(homedir(), ".agents", "ports.md");

export class PortClaimConflict extends Error {
  constructor(readonly ports: number[]) {
    super(`ports already listed in the host registry: ${ports.join(", ")}`);
  }
}

/** The first cell as an integer, as the other writers read it. */
const portOfLine = (line: string) => {
  const port = Number.parseInt(line.split("|")[1]?.trim() ?? "", 10);
  return Number.isInteger(port) ? port : undefined;
};

/** Every port the registry lists. Read without the lock: a hint for drawing, never the check a claim rests on. */
export const registeredPorts = (options: RegistryOptions = {}) => {
  const ports = new Set<number>();
  let text: string;
  try {
    text = readFileSync(pathOf(options), "utf8");
  } catch {
    return ports;
  }
  for (const line of text.split("\n")) {
    const port = portOfLine(line);
    if (port !== undefined) {
      ports.add(port);
    }
  }
  return ports;
};

type OwnRow = { runId: string; pidHint: string };

const ownRow = (line: string): OwnRow | undefined => {
  const cells = line.split("|");
  if (cells.length !== 8 || cells[0] !== "" || cells[7] !== "") {
    return undefined;
  }
  const [port, service, runId, , pidHint] = cells
    .slice(1, 6)
    .map((c) => c.trim());
  return /^\d{1,5}$/.test(port) && service.startsWith(SERVICE_PREFIX)
    ? { runId, pidHint }
    : undefined;
};

/** True only when the kernel says no such process; `kill(pid, 0)` only asks. */
const ownerIsDead = (pidHint: string) => {
  const pid = Number(pidHint);
  if (!/^\d+$/.test(pidHint) || pid <= 0 || pid > PID_MAX) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};

const lock = async (file: string, waitMs: number) => {
  const path = `${file}.lock`;
  const token = `chicmoz-smoke ${process.pid} ${randomBytes(8).toString("hex")}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      // Unlinked only while it still holds this token.
      return () => {
        try {
          if (readFileSync(path, "utf8") === token) {
            unlinkSync(path);
          }
        } catch {
          // Already gone.
        }
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${path} stayed held for ${waitMs / 1000} s; if no registry writer is running, remove it by hand`,
      );
    }
    await sleep(100);
  }
};

/**
 * Rewrites the registry under its lock. `mutate` gets its lines (the last is
 * "" when the file ends in a newline) and returns the new ones, or undefined
 * to write nothing. The rename means no reader sees a torn file.
 */
const withRegistry = async (
  mutate: (lines: string[] | undefined) => string[] | undefined,
  options: RegistryOptions,
) => {
  const file = pathOf(options);
  mkdirSync(dirname(file), { recursive: true });
  const unlock = await lock(file, options.lockWaitMs ?? 30_000);
  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const next = mutate(current?.split("\n"));
    if (next === undefined || next.join("\n") === current) {
      return;
    }
    const target = current === undefined ? file : realpathSync(file);
    const tmp = `${target}.${SERVICE_PREFIX}${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, next.join("\n"));
      // A rename gives the file the umask's mode instead of its own.
      if (current !== undefined) {
        chmodSync(tmp, statSync(target).mode & 0o777);
      }
      renameSync(tmp, target);
    } finally {
      rmSync(tmp, { force: true });
    }
  } finally {
    unlock();
  }
};

const cell = (value: string) => {
  if (value.length === 0 || /[|\r\n]/.test(value)) {
    throw new Error(
      `registry cell ${JSON.stringify(value)} is empty or holds '|' or a newline`,
    );
  }
  return value;
};

/**
 * Under the lock: drops this prefix's rows whose owner is dead, then appends
 * one row per service, or throws `PortClaimConflict` and writes nothing when
 * any line already lists a wanted port.
 */
export const claimPorts = async (
  {
    runId,
    ports,
    ownerPid,
    worktree,
  }: {
    runId: string;
    ports: Record<string, number>;
    /** The process whose life the claim lasts. */
    ownerPid: number;
    worktree: string;
  },
  options: RegistryOptions = {},
) => {
  const claimed = new Date().toISOString();
  const rows = Object.entries(ports).map(
    ([service, port]) =>
      `| ${port} | ${cell(SERVICE_PREFIX + service)} | ${cell(runId)} | ${cell(worktree)} | ${ownerPid} | ${claimed} |`,
  );
  let conflicts: number[] = [];
  await withRegistry((lines) => {
    const kept = (lines ?? []).filter((line) => {
      const row = ownRow(line);
      return row === undefined || !ownerIsDead(row.pidHint);
    });
    const listed = new Set(kept.map(portOfLine));
    conflicts = Object.values(ports).filter((p) => listed.has(p));
    if (conflicts.length > 0) {
      return undefined;
    }
    const base = kept.every((l) => l.trim() === "") ? [...HEADER, ""] : kept;
    const end = base.at(-1) === "" ? base.length - 1 : base.length;
    return [...base.slice(0, end), ...rows, ""];
  }, options);
  if (conflicts.length > 0) {
    throw new PortClaimConflict(conflicts);
  }
};

/**
 * Drops this run's rows. Never throws, so teardown goes on; false, with the
 * reason on stderr, when the registry could not be rewritten, and the
 * caller's teardown then is not clean.
 */
export const releasePorts = async (
  runId: string,
  options: RegistryOptions = {},
) => {
  try {
    await withRegistry(
      (lines) => lines?.filter((line) => ownRow(line)?.runId !== runId),
      options,
    );
    return true;
  } catch (e) {
    process.stderr.write(
      `network-smoke: could not release ${runId}'s ports: ${(e as Error).message}\n`,
    );
    return false;
  }
};
