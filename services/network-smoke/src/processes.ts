import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Every detached group the runner starts carries `NETWORK_SMOKE_RUN=<run id>`. */
export const RUN_MARKER = "NETWORK_SMOKE_RUN";
const STOP_GRACE_MS = 5_000;

export type Started = {
  name: string;
  pgid: number;
  child: ChildProcess;
  /** Stop order: higher tiers stop first, members of one tier together. */
  tier: number;
  stopping: boolean;
};

/** The process group in a `/proc/<pid>/stat` line. */
export const pgrpOf = (stat: string) =>
  // After "(comm)": state ppid pgrp …; comm itself may contain spaces and ")".
  Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);

/** Whether a `/proc/<pid>/environ` text carries exactly this run's marker. */
export const carriesMarker = (environ: string, runId: string) =>
  environ.split("\0").includes(`${RUN_MARKER}=${runId}`);

/**
 * Whether process group `pgid` has a member carrying this run's marker. A
 * group whose leader died can still hold live descendants, and a pgid with no
 * marked member may already belong to someone else. Best effort: the group
 * can empty and its pgid be reused between this scan and a signal.
 */
const hasMarkedMember = (pgid: number, runId: string): boolean => {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      if (
        pgrpOf(readFileSync(`/proc/${entry}/stat`, "utf8")) === pgid &&
        carriesMarker(readFileSync(`/proc/${entry}/environ`, "utf8"), runId)
      ) {
        return true;
      }
    } catch {
      // Exited while we looked, or not readable by us: not ours either way.
    }
  }
  return false;
};

/** Kernel start time of `pid` (clock ticks since boot), or undefined if gone. */
export const startTimeOf = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 overall; the fields after "(comm)" start at field 3.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
};

/**
 * Whether a run's owner still runs. Pid and kernel start time must both match,
 * so a reused pid does not count; a record without a start time falls back to
 * the pid alone.
 */
export const ownerAlive = (
  owner: { ownerPid: number; ownerStart?: string },
  startOf = startTimeOf,
  pidExists = (pid: number) => existsSync(`/proc/${pid}`),
) =>
  owner.ownerStart === undefined
    ? pidExists(owner.ownerPid)
    : startOf(owner.ownerPid) === owner.ownerStart;

const signalGroup = (pgid: number, runId: string, signal: NodeJS.Signals) => {
  if (!hasMarkedMember(pgid, runId)) {
    return false;
  }
  try {
    process.kill(-pgid, signal);
  } catch (e) {
    // ESRCH: the group emptied after the scan.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
      process.stderr.write(
        `network-smoke: ${signal} to group ${pgid}: ${(e as Error).message}\n`,
      );
    }
  }
  return true;
};

const goneWithin = async (pgid: number, runId: string, ms: number) => {
  const deadline = Date.now() + ms;
  while (hasMarkedMember(pgid, runId)) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(100);
  }
  return true;
};

/**
 * TERM, a grace period, then KILL, for one group of this run. Resolves false
 * if a marked member is still alive after KILL.
 */
export const stopGroup = async (pgid: number, runId: string) => {
  if (!signalGroup(pgid, runId, "SIGTERM")) {
    return true;
  }
  if (await goneWithin(pgid, runId, STOP_GRACE_MS)) {
    return true;
  }
  signalGroup(pgid, runId, "SIGKILL");
  return goneWithin(pgid, runId, 2_000);
};

export const readPgids = (runDir: string): number[] => {
  try {
    return readFileSync(join(runDir, "pgids"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => Number(line.split(" ")[2]))
      .filter((pgid) => Number.isInteger(pgid) && pgid > 1);
  } catch {
    return [];
  }
};

export type ProcessGroups = ReturnType<typeof createProcessGroups>;

/**
 * Starts each process detached, so it leads its own group and a terminal
 * Ctrl-C reaches only the runner, which then stops the groups in order.
 */
export const createProcessGroups = (runId: string, runDir: string) => {
  const started: Started[] = [];
  const deaths: string[] = [];

  const start = (
    name: string,
    command: string,
    args: readonly string[],
    {
      cwd,
      env,
      tier,
      inheritOutput = false,
      exitIsDeath = true,
    }: {
      cwd: string;
      env: Record<string, string>;
      tier: number;
      /** Write to the runner's stdout and stderr instead of `logs/<name>.log`. */
      inheritOutput?: boolean;
      exitIsDeath?: boolean;
    },
  ): Started => {
    const out = inheritOutput
      ? "inherit"
      : openSync(join(runDir, "logs", `${name}.log`), "a");
    const child = spawn(command, args, {
      cwd,
      // An explicit environment: nothing from the caller's shell (tokens,
      // TOTAL_DB_RESET, cloud credentials) reaches a child unless named here.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        [RUN_MARKER]: runId,
        ...env,
      },
      detached: true,
      stdio: ["ignore", out, out],
    });
    // A failed spawn emits "error" later; unhandled, it would crash the runner.
    child.on("error", (e) => deaths.push(`${name}: ${e.message}`));
    if (typeof out === "number") {
      closeSync(out);
    }
    if (child.pid === undefined) {
      throw new Error(`${name}: could not start ${command}`);
    }
    const entry: Started = {
      name,
      pgid: child.pid,
      child,
      tier,
      stopping: false,
    };
    started.push(entry);
    child.on("exit", (code, signal) => {
      if (exitIsDeath && !entry.stopping) {
        deaths.push(`${name} exited (${signal ?? `code ${code}`})`);
      }
    });
    appendFileSync(
      join(runDir, "pgids"),
      `${name} ${child.pid} ${child.pid}\n`,
    );
    return entry;
  };

  const stopAll = async () => {
    const tiers = [...new Set(started.map((s) => s.tier))].sort(
      (a, b) => b - a,
    );
    const stuck: string[] = [];
    for (const tier of tiers) {
      const members = started.filter((s) => s.tier === tier);
      members.forEach((s) => (s.stopping = true));
      const stopped = await Promise.all(
        members.map((s) => stopGroup(s.pgid, runId)),
      );
      for (const [i, s] of members.entries()) {
        if (!stopped[i]) {
          // A child that outlived SIGKILL must not keep the runner from
          // exiting with its failure.
          s.child.unref();
          stuck.push(s.name);
        }
      }
    }
    return stuck;
  };

  /** For the `exit` hook: no awaiting, no grace. */
  const killAllSync = () => {
    for (const s of started) {
      s.stopping = true;
      signalGroup(s.pgid, runId, "SIGKILL");
    }
  };

  return { start, stopAll, killAllSync, deaths };
};
