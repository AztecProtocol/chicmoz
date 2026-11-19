import { type Server, createServer } from "node:net";

export const PORT_NAMES = [
  "anvil",
  "aztec",
  "aztecAdmin",
  "aztecP2p",
  "explorerApi",
  "ws",
  "wsHealth",
] as const;
export type Ports = Record<(typeof PORT_NAMES)[number], number>;

const check = (ports: Ports): Ports => {
  const values = Object.values(ports);
  if (new Set(values).size !== values.length) {
    throw new Error(`ports must be distinct: ${values.join(",")}`);
  }
  // websocket-event-publisher always serves its health check on PORT + 1.
  if (ports.wsHealth !== ports.ws + 1) {
    throw new Error(
      `wsHealth must be ws + 1 (got ${ports.ws}, ${ports.wsHealth})`,
    );
  }
  return ports;
};

/** `NETWORK_SMOKE_PORTS`: seven ports in `PORT_NAMES` order. */
export const parsePorts = (value: string): Ports => {
  const numbers = value.split(",").map((p) => Number(p.trim()));
  if (
    numbers.length !== PORT_NAMES.length ||
    numbers.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)
  ) {
    throw new Error(
      `NETWORK_SMOKE_PORTS needs ${PORT_NAMES.length} ports (${PORT_NAMES.join(",")}), got "${value}"`,
    );
  }
  return check(
    Object.fromEntries(
      PORT_NAMES.map((name, i) => [name, numbers[i]]),
    ) as Ports,
  );
};

const listen = (port: number) =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });

const portOf = (server: Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unexpected server address");
  }
  return address.port;
};

/**
 * Free ports from the OS, all held until every one is chosen. Another process
 * can still take one before our child binds it; the child then dies and the
 * run fails naming it.
 */
export const freePorts = async (): Promise<Ports> => {
  const held: Server[] = [];
  try {
    const single = async () => {
      const server = await listen(0);
      held.push(server);
      return portOf(server);
    };
    const [anvil, aztec, aztecAdmin, aztecP2p, explorerApi] = [
      await single(),
      await single(),
      await single(),
      await single(),
      await single(),
    ];
    for (let attempt = 0; attempt < 20; attempt++) {
      const ws = await single();
      try {
        held.push(await listen(ws + 1));
        return check({
          anvil,
          aztec,
          aztecAdmin,
          aztecP2p,
          explorerApi,
          ws,
          wsHealth: ws + 1,
        });
      } catch {
        // ws + 1 is taken; keep ws held so it is not offered again.
      }
    }
    throw new Error("no free adjacent port pair for the websocket publisher");
  } finally {
    await Promise.all(
      held.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  }
};
