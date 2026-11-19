import { type Limiter } from "./limiter.js";

const TIMEOUT_MS = 30_000;
/** Larger than any block or log page the recorder asks for; a bigger answer is refused unread. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const readBounded = async (res: Response): Promise<string> => {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES || !res.body) {
    throw new Error(`response too large or empty (${declared} bytes declared)`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * One request through the limiter: no redirects (the limiter and the
 * loopback checks judge the URL asked for), a deadline, and a size cap.
 */
export const boundedJson = async (
  limiter: Limiter,
  url: string,
  init: { method: "GET" } | { method: "POST"; body: string; headers?: Record<string, string> },
): Promise<{ status: number; ok: boolean; json: unknown; headers: Headers }> => {
  await limiter(url);
  const res = await fetch(url, {
    method: init.method,
    body: init.method === "POST" ? init.body : undefined,
    headers:
      init.method === "POST"
        ? { "content-type": "application/json", ...init.headers }
        : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, ok: res.ok, json: JSON.parse(await readBounded(res)) as unknown, headers: res.headers };
};

/** Plain JSON-RPC call; throws on a JSON-RPC error. */
export const jsonRpc = async (
  limiter: Limiter,
  url: string,
  method: string,
  params: unknown,
): Promise<unknown> => {
  const { json } = await boundedJson(limiter, url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const { result, error } = json as { result?: unknown; error?: { message?: string } };
  if (error !== undefined || result === undefined) {
    throw new Error(`${method}: ${error?.message ?? "no result"}`);
  }
  return result;
};
