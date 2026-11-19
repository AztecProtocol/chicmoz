import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

/** Minimum gap between two requests to one public host; the margin absorbs early timers. */
export const PUBLIC_MIN_INTERVAL_MS = 1050;

const isLoopback = (host: string) =>
  host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));

export type Limiter = (url: string) => Promise<void>;

/**
 * A gate to await before each request. Within one recorder process, requests
 * to one non-loopback host are serialized and spaced by
 * {@link PUBLIC_MIN_INTERVAL_MS}, the first one included, so back-to-back runs
 * keep the spacing too; concurrent runs do not share a gate. Each request is
 * logged with its start time.
 */
export const createLimiter = (log: (line: string) => void): Limiter => {
  const tail = new Map<string, Promise<void>>();
  const created = performance.now();
  const lastStart = new Map<string, number>();
  return (url) => {
    const host = new URL(url).host;
    const previous = tail.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (!isLoopback(new URL(url).hostname)) {
        const wait =
          (lastStart.get(host) ?? created) + PUBLIC_MIN_INTERVAL_MS - performance.now();
        if (wait > 0) {
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      lastStart.set(host, performance.now());
      log(`${new Date().toISOString()} ${host}`);
    });
    tail.set(host, next);
    return next;
  };
};
