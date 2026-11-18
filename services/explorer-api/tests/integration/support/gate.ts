const RENDEZVOUS_TIMEOUT_MS = 10_000;

type AsyncFn<A extends unknown[], R> = (...args: A) => Promise<R>;

/**
 * Makes two concurrent requests meet inside a wrapped function. Once armed,
 * the next two calls wait for each other; every other call passes straight
 * through. A caller left alone fails after a timeout, so a test that awaits
 * its requests can never hang on the gate.
 */
export const createGate = () => {
  let tickets = 0;
  let waiting: Array<() => void> = [];

  const meet = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("only one caller reached the gate"));
      }, RENDEZVOUS_TIMEOUT_MS);
      waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
      if (waiting.length === 2) {
        const pair = waiting;
        waiting = [];
        pair.forEach((release) => release());
      }
    });

  const takeTicket = () => {
    if (tickets === 0) {
      return false;
    }
    tickets--;
    return true;
  };

  return {
    arm: () => {
      tickets = 2;
      waiting = [];
    },
    /** Both callers wait after the call: each holds a result read before either went on. */
    after:
      <A extends unknown[], R>(fn: AsyncFn<A, R>): AsyncFn<A, R> =>
      async (...args) => {
        const participates = takeTicket();
        const result = await fn(...args);
        if (participates) {
          await meet();
        }
        return result;
      },
  };
};

/** One gate per test file; `vi.mock` factories and tests import the same instance. */
export const gate = createGate();
