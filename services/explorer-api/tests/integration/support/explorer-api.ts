import { type Stack, attach, createDatabase } from "@chicmoz/test-harness";
import { type MicroserviceBaseSvc } from "@chicmoz-pkg/microservice-base";
import express from "express";
import { randomBytes } from "node:crypto";
import supertest from "supertest";
import { inject } from "vitest";
import { TEMPLATE_DB } from "./constants.js";

export type ExplorerApiForTest = {
  request: supertest.Agent;
  stack: Stack;
  dbName: string;
  /** KAFKA_NAMESPACE for this file: prefixes its topics, consumer groups and Redis keys. */
  namespace: string;
  close(): Promise<void>;
};

const SHUTDOWN_TIMEOUT_MS = 10_000;

const bounded = async (svc: MicroserviceBaseSvc) => {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    svc.shutdown(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
};

/**
 * explorer-api in process on its own database (cloned from the migrated
 * template) and namespace, with the DB, cache and message-bus services up and
 * the Express app behind a supertest agent. Call once per test file, before
 * any explorer-api module is imported: modules read their environment at
 * import, which is why everything below is a dynamic import.
 */
export const startExplorerApiForTest =
  async (): Promise<ExplorerApiForTest> => {
    const stack = attach(inject("harnessStack"));
    const suffix = randomBytes(4).toString("hex");
    const dbName = `t_${suffix}`;
    const namespace = `t${suffix}`;
    await createDatabase(stack, dbName, { template: TEMPLATE_DB });
    Object.assign(process.env, stack.env, {
      POSTGRES_DB_NAME: dbName,
      KAFKA_NAMESPACE: namespace,
      L2_NETWORK_ID: "SANDBOX",
      NODE_ENV: "test",
    });

    const { MicroserviceBaseSvcState, setLogger, setSvcState } = await import(
      "@chicmoz-pkg/microservice-base"
    );
    const { logger } = await import("../../../src/logger.js");
    setLogger(logger);
    const { cacheService } = await import("@chicmoz-pkg/redis-helper");
    const { databaseService } = await import(
      "../../../src/svcs/database/index.js"
    );
    const { messageBusService } = await import(
      "../../../src/svcs/message-bus/index.js"
    );
    // Same order as the service list; they stop in reverse.
    const services = [databaseService, cacheService, messageBusService];
    for (const svc of services) {
      setSvcState(svc.svcId, MicroserviceBaseSvcState.INITIALIZING);
      await svc.init();
      setSvcState(svc.svcId, MicroserviceBaseSvcState.UP);
    }
    // The cache swallows connection errors and serves from the database, so
    // a wrong REDIS_PORT would otherwise pass every route test.
    if (!cacheService.health()) {
      throw new Error(
        `Redis at ${process.env.REDIS_HOST}:${process.env.REDIS_PORT} is not reachable (cacheService.health() is false)`,
      );
    }

    const { setup } = await import(
      "../../../src/svcs/http-server/express-config.js"
    );
    const app = setup(express(), {
      BODY_LIMIT: "64kb",
      PARAMETER_LIMIT: 100,
      NODE_ENV: "test",
    });

    return {
      request: supertest(app),
      stack,
      dbName,
      namespace,
      close: async () => {
        for (const svc of [...services].reverse()) {
          await bounded(svc);
        }
      },
    };
  };
