import { readFileSync } from "node:fs";
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
    // A connection left open would keep close() from ever calling back.
    const server = createServer((socket) => socket.destroy());
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

const MIN_PORT = 10_000;

/** The kernel's ephemeral floor from `ip_local_port_range`'s text, if usable. */
export const parseEphemeralFloor = (text: string): number | undefined => {
  const floor = Number(text.trim().split(/\s+/)[0]);
  return Number.isInteger(floor) && floor > MIN_PORT + 2 * PORT_NAMES.length
    ? floor
    : undefined;
};

const ephemeralFloor = () => {
  try {
    return parseEphemeralFloor(
      readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8"),
    );
  } catch {
    return undefined;
  }
};

/** A random first port of `span` consecutive ports, all below `floor`. */
export const portBelow = (floor: number, span = 1, random = Math.random) =>
  MIN_PORT + Math.floor(random() * (floor - span - MIN_PORT + 1));

/**
 * Free ports, all held until every one is chosen. Where the kernel's
 * ephemeral range is readable they are random ports below it, which
 * outgoing connections never take; elsewhere the OS assigns them. Another
 * listener can still take one before our child binds it; the child then dies
 * and the run fails naming it.
 */
export const freePorts = async (floor = ephemeralFloor()): Promise<Ports> => {
  const held: Server[] = [];
  const hold = async (port: number) => {
    const server = await listen(port);
    held.push(server);
    return portOf(server);
  };
  const single = async (span = 1) => {
    if (floor === undefined) {
      return hold(0);
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        return await hold(portBelow(floor, span));
      } catch {
        // In use, or one we already hold: draw again.
        continue;
      }
    }
    throw new Error(`no free port between ${MIN_PORT} and ${floor}`);
  };
  try {
    const [anvil, aztec, aztecAdmin, aztecP2p, explorerApi] = [
      await single(),
      await single(),
      await single(),
      await single(),
      await single(),
    ];
    for (let attempt = 0; attempt < 20; attempt++) {
      const ws = await single(2);
      try {
        await hold(ws + 1);
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
