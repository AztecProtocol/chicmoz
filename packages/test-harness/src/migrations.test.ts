import { describe, expect, it } from "vitest";
import {
  MIGRATING_SERVICES,
  OUT_OF_ORDER_ENTRIES,
  appliedMigrationChanges,
  journalViolations,
  listSqlFiles,
  readJournal,
  resolveMigrationsBase,
} from "./migrations.js";

describe("migration journal", () => {
  it.each(MIGRATING_SERVICES)("%s runs every migration, in order", (svc) => {
    expect(
      journalViolations(
        svc,
        readJournal(svc),
        listSqlFiles(svc),
        OUT_OF_ORDER_ENTRIES[svc],
      ),
    ).toEqual([]);
  });

  it("flags every way an entry can be skipped or lost", () => {
    const entry = (idx: number, when: number, tag: string) => ({
      idx,
      when,
      tag,
    });
    const journal = {
      entries: [
        entry(0, 30, "0000_a"),
        entry(1, 20, "0001_late"),
        entry(2, 40, "0002_listed"),
        entry(3, 50, "0003_twice"),
        entry(4, 60, "0003_twice"),
      ],
    };
    const files = [
      "0000_a.sql",
      "0001_late.sql",
      "0002_listed.sql",
      "0009_orphan.sql",
    ];

    expect(
      journalViolations("svc", journal, files, ["0002_listed", "0099_gone"]),
    ).toEqual([
      expect.stringContaining("0003_twice appears more than once"),
      expect.stringContaining("0003_twice has no 0003_twice.sql"),
      expect.stringContaining("0009_orphan.sql has no journal entry"),
      expect.stringContaining("0001_late has when 20, not above 30 (0000_a)"),
      expect.stringContaining(
        "0002_listed is listed as out of order but is not",
      ),
      expect.stringContaining("exception 0099_gone is not in the journal"),
    ]);
  });
});

describe("applied migrations", () => {
  it("are unchanged since the base commit", ({ skip }) => {
    const base = resolveMigrationsBase();
    if (!base.ok) {
      skip(`${base.reason}; set MIGRATIONS_BASE_REF to run this check`);
      return;
    }
    expect(
      MIGRATING_SERVICES.flatMap((svc) =>
        appliedMigrationChanges(base.sha, svc),
      ),
    ).toEqual([]);
  });
});
