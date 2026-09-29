import { type MicroserviceBaseSvc } from "@chicmoz-pkg/microservice-base";
import { cacheService } from "@chicmoz-pkg/redis-helper";
import { databaseService } from "./database/index.js";
import { httpServerService } from "./http-server/index.js";
import { messageBusService } from "./message-bus/index.js";

// Services start in this order and stop in reverse: HTTP, message bus,
// cache, database. The HTTP server (the source-verification route
// publishes) stops before the message bus, and everything stops before the
// database.
export const services: MicroserviceBaseSvc[] = [
  databaseService,
  cacheService,
  messageBusService,
  httpServerService,
];
