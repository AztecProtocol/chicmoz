import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request,
} from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { z } from "zod";

const TIP_METHODS = ["getBlockNumber", "getChainTips"] as const;
type TipMethod = (typeof TIP_METHODS)[number];

const heightSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);

export const tipReadSchema = z.object({
  /** When the node's answer reached the tap, in ms since the epoch. */
  at: z.number(),
  method: z.enum(TIP_METHODS),
  /** The proposed tip the answer named; absent when it named none. */
  proposed: z.number().int().optional(),
  /** Only `getChainTips` answers name the hash. */
  hash: z.string().optional(),
  error: z.string().optional(),
});

export type TipRead = z.infer<typeof tipReadSchema>;

const callSchema = z.object({
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.array(z.unknown()).optional(),
});

const replySchema = z.object({
  id: z.union([z.number(), z.string()]).nullable(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).partial().optional(),
});

const chainTipsSchema = z.object({
  proposed: z.object({ number: heightSchema, hash: z.string() }),
});

/** Any namespace: `aztec_getBlockNumber`, `node_getChainTips`. */
const tipMethodOf = (method: string): TipMethod | undefined => {
  const name = method.slice(method.lastIndexOf("_") + 1);
  return TIP_METHODS.find((m) => m === name);
};

const tipOf = (method: TipMethod, result: unknown) => {
  if (method === "getChainTips") {
    const tips = chainTipsSchema.safeParse(result);
    return tips.success
      ? { proposed: tips.data.proposed.number, hash: tips.data.proposed.hash }
      : undefined;
  }
  const height = heightSchema.safeParse(result);
  return height.success ? { proposed: height.data } : undefined;
};

const asList = (body: unknown): unknown[] =>
  Array.isArray(body) ? body : [body];

/** The proposed-tip reads in one JSON-RPC exchange, batched or not. */
export const tipReadsOf = (
  requestBody: unknown,
  replyBody: unknown,
  at: number,
): TipRead[] => {
  const replies = new Map<number | string, z.infer<typeof replySchema>>();
  for (const item of asList(replyBody)) {
    const reply = replySchema.safeParse(item);
    if (reply.success && reply.data.id !== null) {
      replies.set(reply.data.id, reply.data);
    }
  }
  return asList(requestBody).flatMap((item): TipRead[] => {
    const call = callSchema.safeParse(item);
    const method = call.success ? tipMethodOf(call.data.method) : undefined;
    if (!call.success || method === undefined) {
      return [];
    }
    // `getBlockNumber("proven")` and the other tags read another tip.
    const tag = call.data.params?.[0] ?? "proposed";
    if (method === "getBlockNumber" && tag !== "proposed") {
      return [];
    }
    const reply = replies.get(call.data.id);
    const tip = reply && tipOf(method, reply.result);
    return [
      tip
        ? { at, method, ...tip }
        : { at, method, error: reply?.error?.message ?? "no readable answer" },
    ];
  });
};

const json = (body: Buffer | undefined): unknown => {
  try {
    return body === undefined ? undefined : JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
};

const DECODERS: Record<string, (body: Buffer) => Buffer> = {
  identity: (body) => body,
  gzip: (body) => gunzipSync(body),
  deflate: (body) => inflateSync(body),
  br: (body) => brotliDecompressSync(body),
};

const decoded = (body: Buffer, encoding = "identity") => {
  try {
    return DECODERS[encoding]?.(body);
  } catch {
    return undefined;
  }
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const endToEnd = (headers: IncomingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)),
  );

const readAll = async (stream: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

export type RpcTap = { url: string; close: () => Promise<void> };

/**
 * A pass-through proxy to a node's JSON-RPC that appends each read of the
 * proposed tip, with what the node answered, to `file` as one JSON line. It
 * records what its client read, whichever of the two methods it reads the
 * tip with, without changing what the client gets.
 */
export const startRpcTap = async ({
  port,
  upstream,
  file,
}: {
  port: number;
  upstream: string;
  file: string;
}): Promise<RpcTap> => {
  const target = new URL(upstream);
  writeFileSync(file, "");
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readAll(req);
    const reply = await new Promise<IncomingMessage>((resolve, reject) => {
      const out = request(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: { ...endToEnd(req.headers), host: target.host },
        },
        resolve,
      );
      out.on("error", reject);
      out.end(body);
    });
    const replyBody = await readAll(reply);
    const at = Date.now();
    res.writeHead(reply.statusCode ?? 502, {
      ...endToEnd(reply.headers),
      "content-length": replyBody.length,
    });
    res.end(replyBody);
    return () => {
      const reads = tipReadsOf(
        json(body),
        json(decoded(replyBody, reply.headers["content-encoding"])),
        at,
      );
      if (reads.length > 0) {
        appendFileSync(
          file,
          reads.map((r) => `${JSON.stringify(r)}\n`).join(""),
        );
      }
    };
  };
  const server = createServer((req, res) => {
    handle(req, res).then(
      (record) => {
        try {
          record();
        } catch (e) {
          process.stderr.write(
            `network-smoke: the RPC tap lost a record: ${(e as Error).message}\n`,
          );
        }
      },
      // The client sees a dropped connection, as it would with the node down.
      () => res.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unexpected tap address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

/** The tap's records so far; a line still being written is left out. */
export const readTipReads = (file: string): TipRead[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .slice(0, -1)
    .map((line) => tipReadSchema.parse(JSON.parse(line)));

export type PruneOrder = "shorter-chain-first" | "replacement-first" | "unseen";

/**
 * Which state of a prune to `target` the client read first, by the earliest
 * answer that shows one, whatever order the requests went out in. `before`
 * is the node's chain just before the warp, `since`; earlier answers are
 * left out, since the tip also sat at `target` before the doomed blocks were
 * built. The tip at `target` shows the shorter chain. A tip above it shows
 * the replacement when its hash is not `before`'s there or, without a hash,
 * when it is not the old tip's height; the old tip's height alone shows
 * neither.
 */
export const pruneOrder = (
  reads: TipRead[],
  {
    since,
    target,
    before,
  }: { since: number; target: number; before: Map<number, string> },
) => {
  const oldTip = Math.max(...before.keys());
  const stateOf = ({ proposed, hash }: TipRead) => {
    if (proposed === undefined || proposed < target) {
      return undefined;
    }
    const old =
      hash === undefined
        ? undefined
        : hash.toLowerCase() === before.get(proposed);
    if (proposed === target) {
      return old === false ? undefined : "shorter-chain-first";
    }
    if (old === undefined) {
      return proposed === oldTip ? undefined : "replacement-first";
    }
    return old ? undefined : "replacement-first";
  };
  const after = reads.filter((r) => r.at >= since).sort((a, b) => a.at - b.at);
  const decisive = after.find((r) => stateOf(r) !== undefined);
  const order: PruneOrder = (decisive && stateOf(decisive)) ?? "unseen";
  const count = (method: TipMethod) =>
    after.filter((r) => r.method === method && r.proposed !== undefined).length;
  return {
    order,
    decisiveRead: decisive && {
      method: decisive.method,
      proposed: decisive.proposed,
      hash: decisive.hash,
      afterWarpMs: decisive.at - since,
    },
    readsAfterWarp: {
      getBlockNumber: count("getBlockNumber"),
      getChainTips: count("getChainTips"),
    },
    errorsAfterWarp: after.filter((r) => r.error !== undefined).length,
  };
};
