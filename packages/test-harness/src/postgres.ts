import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Logger, is, sql } from "drizzle-orm";
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { IndexedColumn, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import {
  type MigratingService,
  migrationsDir,
  parseJournal,
} from "./migrations.js";
import { REPO_ROOT } from "./repo.js";
import { type StackInfo } from "./stack.js";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

const checkIdentifier = (name: string) => {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`database name "${name}" must match ${IDENTIFIER}`);
  }
  return name;
};

const credentials = (stack: StackInfo, database: string) => ({
  host: stack.env.POSTGRES_IP,
  port: Number(stack.env.POSTGRES_PORT),
  user: stack.env.POSTGRES_ADMIN,
  password: stack.env.POSTGRES_PASSWORD,
  database,
});

const withDb = async <T>(
  stack: StackInfo,
  database: string,
  use: (db: NodePgDatabase) => Promise<T>,
  logger?: Logger,
): Promise<T> => {
  const pool = new pg.Pool({ ...credentials(stack, database), max: 1 });
  try {
    return await use(drizzle(pool, { logger }));
  } finally {
    await pool.end();
  }
};

/** Cloning from `template` fails while any session is connected to the template. */
export const createDatabase = (
  stack: StackInfo,
  name: string,
  { template }: { template?: string } = {},
): Promise<unknown> =>
  withDb(stack, "postgres", (db) =>
    db.execute(
      template === undefined
        ? sql`CREATE DATABASE ${sql.identifier(checkIdentifier(name))}`
        : sql`CREATE DATABASE ${sql.identifier(
            checkIdentifier(name),
          )} TEMPLATE ${sql.identifier(checkIdentifier(template))}`,
    ),
  );

/**
 * The `<tag>.sql` holding the failing statement: the latest logged query that
 * belongs to a migration file (Drizzle logs each query before running it and
 * logs the rollback after the failure), by Drizzle's own breakpoint split.
 */
const fileOfFailure = (folder: string, queries: readonly string[]) => {
  const { entries } = parseJournal(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  );
  const files = entries.map(({ tag }) => ({
    file: `${tag}.sql`,
    statements: new Set(
      readFileSync(join(folder, `${tag}.sql`), "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.trim()),
    ),
  }));
  for (const query of [...queries].reverse()) {
    const match = files.find(({ statements }) => statements.has(query.trim()));
    if (match) {
      return match.file;
    }
  }
  return "the migrator's own bookkeeping";
};

/**
 * Applies the pending migrations in `folder` with Drizzle's migrator, in
 * process. A failure names the SQL file that holds the failing statement.
 */
export const migrateDir = async (
  stack: StackInfo,
  database: string,
  folder: string,
  label: string,
): Promise<void> => {
  const queries: string[] = [];
  const logger: Logger = {
    logQuery: (q) => {
      queries.push(q);
    },
  };
  try {
    await withDb(
      stack,
      database,
      (db) => migrate(db, { migrationsFolder: folder }),
      logger,
    );
  } catch (e) {
    throw new Error(
      `${label}: ${fileOfFailure(folder, queries)} failed: ${
        (e as Error).message
      }`,
    );
  }
};

const runNode = (script: string, cwd: string, env: Record<string, string>) =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env,
      timeout: 120_000,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

/**
 * Runs a service's built migrate entrypoint (`build/scripts/migrate.js`, the
 * deploy command) against `database`. The child gets only the Postgres
 * variables, so an inherited TOTAL_DB_RESET can never reach it. On failure the
 * migrations are replayed in process into a scratch database to name the file.
 */
export const runMigrateEntrypoint = async (
  stack: StackInfo,
  svc: MigratingService,
  database: string,
): Promise<void> => {
  const cwd = join(REPO_ROOT, "services", svc);
  const script = join(cwd, "build", "scripts", "migrate.js");
  if (!existsSync(script)) {
    throw new Error(
      `${svc}: ${relative(REPO_ROOT, script)} is missing; run yarn build first`,
    );
  }
  const { code, output } = await runNode(script, cwd, {
    PATH: process.env.PATH ?? "",
    POSTGRES_IP: stack.env.POSTGRES_IP,
    POSTGRES_PORT: stack.env.POSTGRES_PORT,
    POSTGRES_ADMIN: stack.env.POSTGRES_ADMIN,
    POSTGRES_PASSWORD: stack.env.POSTGRES_PASSWORD,
    POSTGRES_DB_NAME: checkIdentifier(database),
  });
  const log = join(stack.runDir, `migrate-${svc}-${database}.log`);
  writeFileSync(log, output);
  if (code === 0) {
    return;
  }
  const scratch = `${database}_replay`.slice(0, 63);
  await createDatabase(stack, scratch);
  const located = await migrateDir(
    stack,
    scratch,
    migrationsDir(svc),
    svc,
  ).then(
    () => "an in-process replay of the same migrations passed",
    (e: Error) => e.message,
  );
  throw new Error(
    `${svc}: migrate entrypoint exited ${code} (${relative(
      REPO_ROOT,
      log,
    )}); ${located}`,
  );
};

/** `pg_dump --schema-only`, run inside the Postgres container; the fixed restrict key keeps dumps comparable. */
export const dumpSchema = (
  stack: { exec(service: string, cmd: readonly string[]): Promise<string> },
  database: string,
): Promise<string> =>
  stack.exec("postgres", [
    "pg_dump",
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--restrict-key=harness",
    "-U",
    "admin",
    checkIdentifier(database),
  ]);

const key = (columns: readonly string[]) => [...columns].sort().join(",");

/**
 * Fails unless every table, column, primary key and unique key that the
 * Drizzle schema modules declare exists in `database`. Keys compare by
 * column set, which is what ON CONFLICT targets resolve against. Types,
 * defaults and nullability are not compared.
 */
export const assertDeclaredSchemaExists = async (
  stack: StackInfo,
  schemaModules: readonly Record<string, unknown>[],
  database: string,
  label: string,
): Promise<void> => {
  const [columns, keys] = await withDb(
    stack,
    database,
    async (db) =>
      [
        (
          await db.execute<{ table_name: string; column_name: string }>(
            sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
          )
        ).rows,
        (
          await db.execute<{
            table_name: string;
            is_primary: boolean;
            cols: string[];
          }>(
            sql`SELECT t.relname AS table_name, i.indisprimary AS is_primary,
                   array_agg(a.attname::text) AS cols
              FROM pg_index i
              JOIN pg_class t ON t.oid = i.indrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
              JOIN pg_attribute a ON a.attrelid = t.oid
                   AND a.attnum = ANY ((i.indkey::int2[])[0:i.indnkeyatts - 1])
             WHERE i.indisunique AND i.indisvalid
               AND i.indpred IS NULL AND i.indexprs IS NULL
             GROUP BY t.relname, i.indexrelid, i.indisprimary`,
          )
        ).rows,
      ] as const,
  );
  const present = new Set(
    columns.map((c) => `${c.table_name}.${c.column_name}`),
  );
  const tables = new Set(columns.map((c) => c.table_name));
  const primary = new Set(
    keys
      .filter((k) => k.is_primary)
      .map((k) => `${k.table_name}(${key(k.cols)})`),
  );
  const unique = new Set(keys.map((k) => `${k.table_name}(${key(k.cols)})`));

  const declared = [
    ...new Set(schemaModules.flatMap((m) => Object.values(m))),
  ].filter((v) => is(v, PgTable));
  if (declared.length === 0) {
    throw new Error(`${label}: the schema module declares no tables`);
  }
  const missing: string[] = [];
  for (const table of declared) {
    const config = getTableConfig(table);
    if (!tables.has(config.name)) {
      missing.push(`table ${config.name}`);
      continue;
    }
    for (const column of config.columns) {
      if (!present.has(`${config.name}.${column.name}`)) {
        missing.push(`column ${config.name}.${column.name}`);
      }
    }
    const primaryKeys = [
      ...config.columns.filter((c) => c.primary).map((c) => [c.name]),
      ...config.primaryKeys.map((pk) => pk.columns.map((c) => c.name)),
    ];
    for (const cols of primaryKeys) {
      if (!primary.has(`${config.name}(${key(cols)})`)) {
        missing.push(`primary key ${config.name}(${cols.join(", ")})`);
      }
    }
    const uniqueKeys = [
      ...config.columns.filter((c) => c.isUnique).map((c) => [c.name]),
      ...config.uniqueConstraints.map((u) => u.columns.map((c) => c.name)),
      // Partial and expression indexes have no plain column set to compare;
      // the query above leaves them out on the database side too.
      ...config.indexes
        .filter((i) => i.config.unique && i.config.where === undefined)
        .flatMap(({ config: { columns } }) => {
          const names = columns.map((c) =>
            is(c, IndexedColumn) ? c.name : undefined,
          );
          return names.every((n): n is string => n !== undefined)
            ? [names]
            : [];
        }),
    ];
    for (const cols of uniqueKeys) {
      if (!unique.has(`${config.name}(${key(cols)})`)) {
        missing.push(`unique key ${config.name}(${cols.join(", ")})`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${label}: declared but missing in ${database}: ${missing.join("; ")}`,
    );
  }
};
