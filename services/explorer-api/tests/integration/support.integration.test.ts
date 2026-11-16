import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_DB } from "./support/constants.js";
import {
  type ExplorerApiForTest,
  startExplorerApiForTest,
} from "./support/explorer-api.js";
import { chainInfoEvent } from "./support/fixtures.js";

describe("startExplorerApiForTest", () => {
  let api: ExplorerApiForTest;

  beforeAll(async () => {
    api = await startExplorerApiForTest();
  });

  afterAll(async () => {
    await api?.close();
  });

  it("brings up the database, cache and message bus on this file's own database and namespace", async () => {
    const { MicroserviceBaseSvcState, getMicroserviceState } = await import(
      "@chicmoz-pkg/microservice-base"
    );
    const { UP } = MicroserviceBaseSvcState;
    expect(getMicroserviceState()).toEqual({ DB: UP, CACHE: UP, MB: UP });

    const { getDb } = await import("@chicmoz-pkg/postgres-helper");
    const { rows } = await getDb().execute<{ name: string }>(
      sql`SELECT current_database() AS name`,
    );
    expect(rows[0].name).toBe(api.dbName);
    expect(api.dbName).not.toBe(TEMPLATE_DB);

    // A real publish: SASL login and topic creation under this namespace.
    const { publishMessage } = await import(
      "../../src/svcs/message-bus/index.js"
    );
    await publishMessage("CHAIN_INFO_EVENT", chainInfoEvent);
    const topics = await api.stack.exec("kafka", [
      "/opt/kafka/bin/kafka-topics.sh",
      "--bootstrap-server",
      "localhost:9092",
      "--command-config",
      "/etc/kafka/secrets/client.properties",
      "--list",
    ]);
    expect(topics.split("\n")).toContain(
      `${api.namespace}.SANDBOX__CHAIN_INFO_EVENT`,
    );
  });
});
