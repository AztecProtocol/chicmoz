import {
  MicroserviceBaseSvcState,
  getSvcState,
  type MicroserviceBaseSvc,
} from "@chicmoz-pkg/microservice-base";
import { type DrizzleConfig } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { dbCredentials, getConfigStr } from "./environment.js";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
const serviceId = "DB";

const DEFAULT_POOL_CONFIG = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

const init = async (
  drizzleConfig: DrizzleConfig<Record<string, unknown>>,
  poolConfig = DEFAULT_POOL_CONFIG,
) => {
  pool = new pg.Pool({
    ...dbCredentials,
    ...poolConfig,
  });

  // Log pool events for debugging
  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[POSTGRES] Unexpected error on idle client", err);
  });

  db = drizzle(pool, drizzleConfig);

  try {
    const client = await pool.connect();
    client.release();
    // eslint-disable-next-line no-console
    console.log("[POSTGRES] Database connection pool established successfully");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[POSTGRES] Failed to establish database connection pool",
      err,
    );
    throw err;
  }
};

const DB_NOT_READY_MESSAGES = {
  notInitialized: "Database is not initialized",
  shuttingDown: "Database is shutting down",
  down: "Database is down",
  initializing: "Database is initializing",
};

// True for the errors getDb throws while the database service is not up, for
// callers that poll during startup and should wait rather than fail.
export const isDatabaseNotReadyError = (error: unknown) =>
  error instanceof Error &&
  Object.values(DB_NOT_READY_MESSAGES).includes(error.message);

export const getDb = () => {
  let state: MicroserviceBaseSvcState;
  try {
    state = getSvcState(serviceId);
  } catch (error) {
    throw new Error(DB_NOT_READY_MESSAGES.notInitialized);
  }

  if (state !== MicroserviceBaseSvcState.UP) {
    if (state === MicroserviceBaseSvcState.SHUTTING_DOWN) {
      throw new Error(DB_NOT_READY_MESSAGES.shuttingDown);
    } else if (state === MicroserviceBaseSvcState.DOWN) {
      throw new Error(DB_NOT_READY_MESSAGES.down);
    } else if (state === MicroserviceBaseSvcState.INITIALIZING) {
      throw new Error(DB_NOT_READY_MESSAGES.initializing);
    }
  }
  return db;
};

export const getPool = () => {
  if (!pool) {
    throw new Error("Database pool is not initialized");
  }
  return pool;
};

export const generateSvc: (
  drizzleConf: DrizzleConfig<Record<string, unknown>>,
  poolConfig?: typeof DEFAULT_POOL_CONFIG,
) => MicroserviceBaseSvc = (drizzleConf, poolConfig) => ({
  svcId: "DB",
  init: () => init(drizzleConf, poolConfig),
  getConfigStr,
  health: () => getSvcState(serviceId) === MicroserviceBaseSvcState.UP,
  shutdown: async () => {
    await pool.end();
  },
});
