import { type ChicmozL2Block, chicmozL2BlockSchema } from "@chicmoz-pkg/types";
import { WebSocket } from "ws";

export type WsClient = {
  blocks: ChicmozL2Block[];
  /** Block frames that failed the shared schema, with the reason. */
  rejected: string[];
  close(): void;
};

/**
 * Resolves once the socket is open. Handlers are attached first: the
 * publisher keeps no history, so a frame sent before that is gone.
 */
export const connectWs = (url: string, timeoutMs = 10_000) =>
  new Promise<WsClient>((resolve, reject) => {
    const socket = new WebSocket(url);
    const client: WsClient = {
      blocks: [],
      rejected: [],
      close: () => socket.close(),
    };
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`websocket ${url} did not open within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as { block?: unknown };
      if (frame.block === undefined) {
        return;
      }
      const parsed = chicmozL2BlockSchema.safeParse(frame.block);
      if (parsed.success) {
        client.blocks.push(parsed.data);
      } else {
        client.rejected.push(parsed.error.message);
      }
    });
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
