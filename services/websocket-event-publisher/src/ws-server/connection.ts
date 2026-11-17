import { type WebSocket, type WebSocketServer } from "ws";
import { logger } from "../logger.js";

export const handleConnection = (
  server: WebSocketServer,
  socket: WebSocket,
) => {
  logger.info(`🧍 WS: client connected    (total: ${server.clients.size})`);
  // ws has already started closing this socket when it emits "error".
  socket.on("error", (err) => {
    logger.warn(`WS: client error, closing its socket: ${err.message}`);
  });
  socket.on("close", () => {
    logger.info(`🚪 WS: client disconnected (total: ${server.clients.size})`);
  });
};
