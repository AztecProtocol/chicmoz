import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Every process the runner starts carries `NETWORK_SMOKE_RUN=<run id>`. */
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

/**
 * Pids in process group `pgid` whose environment carries this run's marker.
 * A group whose leader died can still hold live descendants, and a pgid with
 * no marked member may already belong to someone else.
 */
export const markedMembers = (pgid: number, runId: string): number[] => {
  const marker = `${RUN_MARKER}=${runId}`;
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // After "(comm)": state ppid pgrp …; comm itself may contain spaces.
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (
        pgrp === pgid &&
        readFileSync(`/proc/${entry}/environ`, "utf8")
          .split("\0")
          .includes(marker)
      ) {
        pids.push(Number(entry));
      }
    } catch {
      // Exited while we looked, or not readable by us: not ours either way.
    }
  }
  return pids;
};

const signalGroup = (pgid: number, runId: string, signal: NodeJS.Signals) => {
  if (markedMembers(pgid, runId).length === 0) {
    return false;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group emptied between the check and the signal.
  }
  return true;
};

/** TERM, a grace period, then KILL, for one group of this run. */
export const stopGroup = async (pgid: number, runId: string) => {
  if (!signalGroup(pgid, runId, "SIGTERM")) {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (markedMembers(pgid, runId).length === 0) {
      return;
    }
    await sleep(100);
  }
  signalGroup(pgid, runId, "SIGKILL");
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
    }: { cwd: string; env: Record<string, string>; tier: number },
  ): Started => {
    const out = openSync(join(runDir, "logs", `${name}.log`), "a");
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
    closeSync(out);
    if (child.pid === undefined) {
      throw new Error(`${name}: could not start ${command}`);
    }
    // A detached child leads its own group: pgid = pid. Recorded before any
    // await, so `down` finds it even if the runner is killed right after.
    appendFileSync(
      join(runDir, "pgids"),
      `${name} ${child.pid} ${child.pid}\n`,
    );
    const entry: Started = {
      name,
      pgid: child.pid,
      child,
      tier,
      stopping: false,
    };
    child.on("exit", (code, signal) => {
      if (!entry.stopping) {
        deaths.push(`${name} exited (${signal ?? `code ${code}`})`);
      }
    });
    child.on("error", (e) => deaths.push(`${name}: ${e.message}`));
    started.push(entry);
    return entry;
  };

  const stopAll = async () => {
    const tiers = [...new Set(started.map((s) => s.tier))].sort(
      (a, b) => b - a,
    );
    for (const tier of tiers) {
      const members = started.filter((s) => s.tier === tier);
      members.forEach((s) => (s.stopping = true));
      await Promise.all(members.map((s) => stopGroup(s.pgid, runId)));
    }
  };

  /** For the `exit` hook: no awaiting, no grace. */
  const killAllSync = () => {
    for (const s of started) {
      s.stopping = true;
      signalGroup(s.pgid, runId, "SIGKILL");
    }
  };

  const isAlive = (s: Started) =>
    s.child.exitCode === null && s.child.signalCode === null;

  return { start, stopAll, killAllSync, isAlive, deaths };
};
