import { setTimeout as sleep } from "node:timers/promises";

const REQUEST_TIMEOUT_MS = 5_000;

/** One JSON-RPC call; throws on a transport error, an RPC error or no result. */
export const rpc = async (
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<unknown> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (body.error !== undefined || body.result === undefined) {
    throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
  }
  return body.result;
};

export const httpOk = async (url: string) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.ok;
};

/**
 * Polls `check` until it returns true. Fails at the deadline with the last
 * error, as soon as `dead()` names a child that died (a lost port bind must
 * not be mistaken for readiness), or when `signal` aborts.
 */
export const waitUntil = async (
  what: string,
  check: () => Promise<boolean>,
  {
    timeoutMs,
    dead,
    signal,
    intervalMs = 500,
  }: {
    timeoutMs: number;
    dead: () => string | undefined;
    signal: AbortSignal;
    intervalMs?: number;
  },
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  for (;;) {
    signal.throwIfAborted();
    const died = dead();
    if (died) {
      throw new Error(`${what}: ${died}`);
    }
    let ready = false;
    try {
      ready = await check();
    } catch (e) {
      last = (e as Error).message;
    }
    if (ready) {
      signal.throwIfAborted();
      const diedMeanwhile = dead();
      if (diedMeanwhile) {
        throw new Error(`${what}: ${diedMeanwhile}`);
      }
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: not ready after ${timeoutMs / 1000}s (${last})`,
      );
    }
    await sleep(intervalMs);
  }
};

/**
 * `Promise.all` that waits for every promise to settle before rejecting with
 * the first failure, so no sibling is still running when the caller cleans up.
 */
export const settleAll = async (work: Promise<unknown>[]): Promise<void> => {
  const failed = (await Promise.allSettled(work)).find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
};
