import { type MicroserviceBaseSvc } from "@chicmoz-pkg/microservice-base";
import { cacheService } from "@chicmoz-pkg/redis-helper";
import { databaseService } from "./database/index.js";
import { httpServerService } from "./http-server/index.js";
import { messageBusService } from "./message-bus/index.js";
import { reconciliationService } from "./reconciliation/index.js";

// Services start in this order and stop in reverse: reconciliation, HTTP,
// message bus, cache, database. Anything that publishes (reconciliation
// ticks, the source-verification route) stops before the message bus, and
// everything stops before the database.
export const services: MicroserviceBaseSvc[] = [
  databaseService,
  cacheService,
  messageBusService,
  httpServerService,
  reconciliationService,
];
