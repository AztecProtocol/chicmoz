import { type ChicmozL2Block, chicmozL2BlockSchema } from "@chicmoz-pkg/types";
import { WebSocket } from "ws";
import { z } from "zod";

/** A block or tips frame, at its arrival; for tips, `height` and `hash` are the proposed tip's. */
export type WsFrame = {
  at: number;
  kind: "block" | "l2Tips";
  height?: number;
  hash?: string;
};

export type WsClient = {
  blocks: ChicmozL2Block[];
  /** Block frames that failed the shared schema, with the reason. */
  rejected: string[];
  frames: WsFrame[];
  /** When the socket closed, if it has. */
  closedAt?: number;
  close(): void;
};

const proposedTip = z.object({
  proposed: z.object({
    number: z.coerce.number(),
    hash: z.string().optional(),
  }),
});

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
      frames: [],
      close: () => socket.close(),
    };
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`websocket ${url} did not open within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on("message", (data: Buffer) => {
      const at = Date.now();
      const frame = JSON.parse(data.toString()) as {
        block?: unknown;
        l2Tips?: unknown;
      };
      if (frame.l2Tips !== undefined) {
        const tips = proposedTip.safeParse(frame.l2Tips);
        client.frames.push({
          at,
          kind: "l2Tips",
          height: tips.success ? tips.data.proposed.number : undefined,
          hash: tips.success
            ? tips.data.proposed.hash?.toLowerCase()
            : undefined,
        });
        return;
      }
      if (frame.block === undefined) {
        return;
      }
      const parsed = chicmozL2BlockSchema.safeParse(frame.block);
      if (parsed.success) {
        client.blocks.push(parsed.data);
        client.frames.push({
          at,
          kind: "block",
          height: Number(parsed.data.height),
          hash: parsed.data.hash.toLowerCase(),
        });
      } else {
        client.rejected.push(parsed.error.message);
        client.frames.push({ at, kind: "block" });
      }
    });
    socket.once("close", () => {
      client.closedAt = Date.now();
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
