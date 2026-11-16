import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { REPO_ROOT, git } from "./repo.js";

export const MIGRATING_SERVICES = [
  "explorer-api",
  "aztec-listener",
  "ethereum-listener",
] as const;
export type MigratingService = (typeof MIGRATING_SERVICES)[number];

const journalSchema = z.object({
  entries: z.array(
    z
      .object({
        idx: z.number().int(),
        when: z.number().int(),
        tag: z.string().min(1),
      })
      .passthrough(),
  ),
});
export type Journal = z.infer<typeof journalSchema>;

const JOURNAL_PATH = "meta/_journal.json";

/**
 * Entries allowed to break the running maximum of `when`. Drizzle applies an
 * entry only when its `when` exceeds the newest applied `created_at`, so each
 * entry listed here never runs on a database that applied a later-dated one first.
 */
export const OUT_OF_ORDER_ENTRIES: Record<MigratingService, readonly string[]> =
  {
    "explorer-api": [],
    "aztec-listener": [],
    // Data-only rename dated before 0000: databases that ran 0000 before it shipped skip it.
    "ethereum-listener": ["0001_rename_l2_block_proposed"],
  };

export const migrationsDir = (svc: MigratingService): string =>
  path.join(REPO_ROOT, "services", svc, "migrations");

export const parseJournal = (json: string): Journal =>
  journalSchema.parse(JSON.parse(json));

export const readJournal = (svc: MigratingService): Journal =>
  parseJournal(
    readFileSync(path.join(migrationsDir(svc), JOURNAL_PATH), "utf8"),
  );

export const listSqlFiles = (svc: MigratingService): string[] =>
  readdirSync(migrationsDir(svc)).filter((file) => file.endsWith(".sql"));

/** Every way the journal can make Drizzle skip, or fail to find, a migration. */
export const journalViolations = (
  svc: string,
  journal: Journal,
  sqlFiles: readonly string[],
  outOfOrder: readonly string[],
): string[] => {
  const violations: string[] = [];
  const tags = journal.entries.map((entry) => entry.tag);
  const tagSet = new Set(tags);
  const files = new Set(sqlFiles);

  for (const tag of new Set(tags.filter((t, i) => tags.indexOf(t) !== i))) {
    violations.push(`${svc}: tag ${tag} appears more than once in the journal`);
  }
  for (const tag of tagSet) {
    if (!files.has(`${tag}.sql`)) {
      violations.push(`${svc}: journal entry ${tag} has no ${tag}.sql`);
    }
  }
  for (const file of files) {
    if (!tagSet.has(file.slice(0, -".sql".length))) {
      violations.push(
        `${svc}: ${file} has no journal entry, so Drizzle never runs it`,
      );
    }
  }

  let max: { when: number; tag: string } | undefined;
  for (const { when, tag } of journal.entries) {
    const inOrder = max === undefined || when > max.when;
    if (outOfOrder.includes(tag)) {
      if (inOrder) {
        violations.push(
          `${svc}: ${tag} is listed as out of order but is not; remove the exception`,
        );
      }
    } else if (max !== undefined && !inOrder) {
      violations.push(
        `${svc}: ${tag} has when ${when}, not above ${max.when} (${max.tag}); Drizzle skips it on any database that already ran ${max.tag}`,
      );
    }
    if (max === undefined || when > max.when) {
      max = { when, tag };
    }
  }
  for (const tag of outOfOrder) {
    if (!tagSet.has(tag)) {
      violations.push(
        `${svc}: exception ${tag} is not in the journal; remove it`,
      );
    }
  }
  return violations;
};

export type MigrationsBase =
  | { ok: true; sha: string; source: string }
  | { ok: false; reason: string };

/**
 * The commit whose migrations count as applied: `MIGRATIONS_BASE_REF` when set
 * (it must then resolve), else the merge base with `origin/main`. A shallow
 * clone has neither, which callers report as a skip rather than a pass.
 */
export const resolveMigrationsBase = (
  explicit = process.env.MIGRATIONS_BASE_REF,
): MigrationsBase => {
  if (explicit) {
    try {
      const sha = git([
        "rev-parse",
        "--verify",
        "--quiet",
        `${explicit}^{commit}`,
      ]);
      return { ok: true, sha: sha.trim(), source: "MIGRATIONS_BASE_REF" };
    } catch {
      throw new Error(
        `MIGRATIONS_BASE_REF=${explicit} is not a commit in this clone; fetch full history (fetch-depth: 0)`,
      );
    }
  }
  try {
    const sha = git(["merge-base", "HEAD", "origin/main"]);
    return { ok: true, sha: sha.trim(), source: "merge base with origin/main" };
  } catch {
    return {
      ok: false,
      reason: "no merge base with origin/main (shallow or partial clone)",
    };
  }
};

/**
 * Applied migrations that differ between `baseSha` and the working tree: any
 * file under `migrations/` modified or deleted, and any base journal entry not
 * kept verbatim at the same position. Added files and appended entries pass.
 */
export const appliedMigrationChanges = (
  baseSha: string,
  svc: MigratingService,
): string[] => {
  const dir = `services/${svc}/migrations`;
  const journalFile = `${dir}/${JOURNAL_PATH}`;
  const base = baseSha.slice(0, 12);
  const violations: string[] = [];

  const fields = git([
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-status",
    "-z",
    baseSha,
    "--",
    dir,
  ])
    .split("\0")
    .filter(Boolean);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, file] = [fields[i], fields[i + 1]];
    if (status === "A" || (status === "M" && file === journalFile)) {
      continue;
    }
    violations.push(
      `${svc}: ${file} ${status === "D" ? "was deleted" : "changed"} since ${base}; an applied migration must stay byte-identical`,
    );
  }

  let baseJson: string;
  try {
    baseJson = git(["show", `${baseSha}:${journalFile}`]);
  } catch {
    // The service had no migrations at base.
    return violations;
  }
  const baseJournal = parseJournal(baseJson);
  const head = readJournal(svc);
  baseJournal.entries.forEach((entry, i) => {
    if (!isDeepStrictEqual(entry, head.entries[i])) {
      violations.push(
        `${svc}: journal entry ${i} (${entry.tag}) changed since ${base}; append new entries, never edit or reorder applied ones`,
      );
    }
  });
  return violations;
};
