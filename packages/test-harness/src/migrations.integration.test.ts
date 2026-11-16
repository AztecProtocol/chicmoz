import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, inject, it } from "vitest";
import {
  MIGRATING_SERVICES,
  type MigratingService,
  migrationsDir,
  resolveMigrationsBase,
} from "./migrations.js";
import {
  assertDeclaredSchemaExists,
  createDatabase,
  dumpSchema,
  migrateDir,
  runMigrateEntrypoint,
} from "./postgres.js";
import { REPO_ROOT } from "./repo.js";
import { attach } from "./stack.js";

/** The built schema, as each service's drizzle.config selects it (a directory means every module in it). */
const SCHEMA_PATHS: Record<MigratingService, string> = {
  "explorer-api": "build/src/svcs/database/schema",
  "aztec-listener": "build/src/svcs/database/schema.js",
  "ethereum-listener": "build/src/svcs/database/schema.js",
};

const loadSchema = (svc: MigratingService) => {
  const path = join(REPO_ROOT, "services", svc, SCHEMA_PATHS[svc]);
  const files = path.endsWith(".js")
    ? [path]
    : readdirSync(path, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".js"))
        .map((file) => join(path, file));
  return Promise.all(
    files.map(
      async (file) =>
        (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    ),
  );
};

const stack = attach(inject("harnessStack"));
const dbName = (prefix: string, svc: MigratingService) =>
  `${prefix}_${svc.replaceAll("-", "_")}`;

describe.concurrent.each(MIGRATING_SERVICES)("%s migrations", (svc) => {
  it("build the declared schema from empty through the deploy entrypoint, and re-run as a no-op", async () => {
    const db = dbName("empty", svc);
    await createDatabase(stack, db);
    await runMigrateEntrypoint(stack, svc, db);
    await assertDeclaredSchemaExists(stack, await loadSchema(svc), db, svc);

    const before = await dumpSchema(stack, db);
    await migrateDir(stack, db, migrationsDir(svc), svc);
    expect(await dumpSchema(stack, db)).toBe(before);
  });

  it("upgrade from the base commit to the same schema as a fresh database", async ({
    skip,
  }) => {
    const base = resolveMigrationsBase();
    if (!base.ok) {
      skip(`${base.reason}; set MIGRATIONS_BASE_REF to run this check`);
      return;
    }
    const baseRoot = join(stack.runDir, "base", svc);
    mkdirSync(baseRoot, { recursive: true });
    const archive = join(baseRoot, "migrations.tar");
    const folder = `services/${svc}/migrations`;
    execFileSync("git", ["archive", `--output=${archive}`, base.sha, folder], {
      cwd: REPO_ROOT,
    });
    execFileSync("tar", ["-xf", archive, "-C", baseRoot]);

    const upgraded = dbName("upgraded", svc);
    const fresh = dbName("fresh", svc);
    await Promise.all([
      createDatabase(stack, upgraded),
      createDatabase(stack, fresh),
    ]);
    await migrateDir(stack, upgraded, join(baseRoot, folder), `${svc} at base`);
    await migrateDir(stack, upgraded, migrationsDir(svc), svc);
    await migrateDir(stack, fresh, migrationsDir(svc), svc);
    expect(await dumpSchema(stack, upgraded)).toBe(
      await dumpSchema(stack, fresh),
    );
  });
});
