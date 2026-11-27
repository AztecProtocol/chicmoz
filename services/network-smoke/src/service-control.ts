import { createServer } from "node:http";

/** What a scenario may do to one of the run's services. */
export type ServiceActions = {
  /** Ends its process group with SIGKILL, as a crash would; resolves once it is gone. */
  kill: (name: string) => Promise<void>;
  /** Starts it again as the run first did; only after `kill`. */
  start: (name: string) => Promise<void>;
};

export type ServiceControl = { url: string; close: () => Promise<void> };

const ROUTE = /^\/services\/([a-z-]+)\/(kill|start)$/;

/**
 * Serves `POST /services/<name>/kill` and `POST /services/<name>/start` on
 * 127.0.0.1 for the run's own services, so the runner, not the scenario,
 * starts every process the run tears down. Once `signal` aborts, it refuses
 * every action and closes, so no service starts again behind the teardown's
 * stops; `close` can be called again.
 */
export const startServiceControl = async ({
  port,
  names,
  actions,
  signal,
}: {
  port: number;
  names: readonly string[];
  actions: ServiceActions;
  signal: AbortSignal;
}): Promise<ServiceControl> => {
  const killed = new Set<string>();
  const act = async (name: string, action: "kill" | "start") => {
    if (action === "kill") {
      await actions.kill(name);
      killed.add(name);
      return;
    }
    if (!killed.delete(name)) {
      throw new Error(`${name} runs; kill it before starting it again`);
    }
    await actions.start(name);
  };
  const server = createServer((req, res) => {
    const [, name, action] = ROUTE.exec(req.url ?? "") ?? [];
    if (req.method !== "POST" || name === undefined || !names.includes(name)) {
      res.writeHead(404).end();
      return;
    }
    if (signal.aborted) {
      res.writeHead(409).end("the run is tearing down");
      return;
    }
    act(name, action as "kill" | "start").then(
      () => res.writeHead(204).end(),
      (e: Error) => res.writeHead(409).end(e.message),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unexpected service control address");
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }));
  signal.addEventListener("abort", () => void close(), { once: true });
  return { url: `http://127.0.0.1:${address.port}`, close };
};

/** The scenario's side of `startServiceControl`. */
export const serviceControl = (url: string) => {
  const call = async (name: string, action: "kill" | "start") => {
    const res = await fetch(new URL(`/services/${name}/${action}`, url), {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`${action} ${name}: ${res.status} ${await res.text()}`);
    }
  };
  return {
    kill: (name: string) => call(name, "kill"),
    start: (name: string) => call(name, "start"),
  };
};
