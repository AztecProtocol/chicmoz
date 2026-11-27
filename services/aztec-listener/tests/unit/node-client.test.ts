import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { type AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import {
  overwriteLoggingStream,
  setLogLevel,
} from "@aztec-labs/foundation/log";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedElectionReaders } from "../../src/svcs/poller/network-client/election-probe.js";
import { callNodeFunction } from "../../src/svcs/poller/network-client/index.js";
import { nodeClient } from "../../src/svcs/poller/network-client/pool.js";
import { readLatestRollupVersion } from "../../src/svcs/poller/network-client/rollup-version.js";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const events = vi.hoisted(() => ({
  onChainInfo: vi.fn(),
  onL2RpcNodeAlive: vi.fn(),
  onL2RpcNodeError: vi.fn(),
  onL2RpcNodeInfo: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({ logger }));
vi.mock("../../src/events/emitted/index.js", () => events);
vi.mock("../../src/environment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/environment.js")>()),
  AZTEC_RPC_URLS: [{ name: "gateway", url: "http://gateway:8080" }],
}));

const KEYS = /key123secret|key456secret/;
const sdkOutput: string[] = [];

beforeAll(() => {
  // Vitest runs the SDK's logger silent.
  overwriteLoggingStream(
    new Writable({
      write(chunk, _encoding, done) {
        sdkOutput.push(String(chunk));
        done();
      },
    }),
  );
  setLogLevel("info");
});

beforeEach(() => {
  vi.clearAllMocks();
  sdkOutput.length = 0;
});

/** A keyed node at a local server that answers each request with `answer`. */
const keyedNode = async (
  answer: (req: IncomingMessage, res: ServerResponse) => void,
) => {
  const server = createServer(answer);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/v1/key123secret?apikey=key456secret`;
  return {
    node: { name: "keyed", url, instance: nodeClient(url) },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const ours = () =>
  [logger.info, logger.warn, logger.error]
    .flatMap((log) => log.mock.calls.map(([message]) => String(message)))
    .join("\n");

describe("node client", () => {
  it("redacts the node's URL in a transport failure's error, the SDK's log and the listener's", async () => {
    const { node, close } = await keyedNode((req) => req.socket.destroy());
    let failure: unknown;
    try {
      failure = await callNodeFunction("getNodeInfo", [], node).catch(
        (e: unknown) => e,
      );
      expect(await readLatestRollupVersion([node], 10_000)).toBeUndefined();
    } finally {
      await close();
    }

    const thrown = inspect(failure, { depth: Infinity });
    expect(thrown).toContain(
      "Error fetching from host <url>: [TypeError: fetch failed]",
    );
    expect(ours()).toContain(
      "Node keyed reported no rollup version: Error fetching from host <url>",
    );
    expect(sdkOutput.join("")).toContain(
      "Failed to fetch from the remote server",
    );
    expect(thrown + ours() + sdkOutput.join("")).not.toMatch(KEYS);
  });

  it("still marks a node offline on an answer naming Service Unavailable, the URL redacted in its error event", async () => {
    const { node, close } = await keyedNode((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Service Unavailable" } }));
    });
    try {
      await expect(callNodeFunction("getNodeInfo", [], node)).rejects.toThrow(
        "Service Unavailable",
      );
    } finally {
      await close();
    }

    expect(events.onL2RpcNodeError).toHaveBeenCalledTimes(1);
    const [error, rpcUrl] = events.onL2RpcNodeError.mock.calls[0] as [
      { message: string },
      string,
    ];
    expect(error.message).toBe(
      "Error 503 from server <url>: Service Unavailable",
    );
    expect(rpcUrl).toBe(node.url);
    expect(JSON.stringify(error) + ours() + sdkOutput.join("")).not.toMatch(
      KEYS,
    );
  });

  it("still marks a node offline on Bad Gateway when a pool host is named gateway", async () => {
    const url = "http://gateway:8080";
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "Bad Gateway" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    try {
      await expect(
        callNodeFunction("getNodeInfo", [], {
          name: "gateway",
          url,
          instance: nodeClient(url),
        }),
      ).rejects.toThrow("Bad Gateway");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(events.onL2RpcNodeError).toHaveBeenCalledTimes(1);
    const [error] = events.onL2RpcNodeError.mock.calls[0] as [
      { message: string },
    ];
    expect(error.message).toBe("Error 502 from server <url>: Bad Gateway");
  });

  it("redacts a userinfo URL in the election probe's errors", async () => {
    const url = "http://operator:pw-key123secret@127.0.0.1:1/v1/key456secret";
    const failure = await boundedElectionReaders(10_000)({
      name: "userinfo",
      url,
      instance: nodeClient(url),
    })
      .getChainTips()
      .catch((e: unknown) => e);

    const thrown = inspect(failure, { depth: Infinity });
    expect(thrown).toContain("includes credentials: <url>");
    expect(thrown + sdkOutput.join("")).not.toMatch(KEYS);
  });
});
