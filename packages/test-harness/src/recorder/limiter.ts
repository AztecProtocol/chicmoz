/** Minimum gap between two requests to one public host; the margin absorbs early timers. */
export const PUBLIC_MIN_INTERVAL_MS = 1050;

const isLoopback = (host: string) =>
  host === "localhost" || host.startsWith("127.") || host === "[::1]";

export type Limiter = (url: string) => Promise<void>;

/**
 * Returns a gate to await before each request. Requests to one non-loopback
 * host are serialized and spaced by {@link PUBLIC_MIN_INTERVAL_MS}, the first
 * one included, so back-to-back recorder runs keep the spacing too. Each
 * request is reported to `log` with its start time.
 */
export const createLimiter = (log: (line: string) => void): Limiter => {
  const tail = new Map<string, Promise<void>>();
  const created = Date.now();
  const lastStart = new Map<string, number>();
  return (url) => {
    const host = new URL(url).host;
    const previous = tail.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (!isLoopback(new URL(url).hostname)) {
        const wait =
          (lastStart.get(host) ?? created) + PUBLIC_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) {
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      lastStart.set(host, Date.now());
      log(`${new Date().toISOString()} ${host}`);
    });
    tail.set(host, next);
    return next;
  };
};
