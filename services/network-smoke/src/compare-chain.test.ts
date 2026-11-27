import { execFile } from "node:child_process";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { loadFixture } from "@chicmoz/test-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startScriptedNode } from "./scripted-node.js";

const SCRIPT = fileURLToPath(
  new URL("../scripts/compare-chain.ts", import.meta.url),
);

const KEYS = ["usr-5c1e", "pwd-5c1e", "pth-5c1e", "qry-5c1e"];
const [USER, PASSWORD, PATH, QUERY] = KEYS;

const run = (
  check: "sample" | "window" | "reorgs",
  nodeUrl: string,
  apiUrl: string,
  env: Record<string, string> = {},
) =>
  new Promise<{ code: number; output: string }>((resolve) =>
    execFile(
      process.execPath,
      [SCRIPT, check],
      {
        env: {
          ...process.env,
          COMPARE_NODE_URL: nodeUrl,
          COMPARE_API_URL: apiUrl,
          ...env,
        },
        timeout: 30_000,
      },
      (error, stdout, stderr) =>
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          output: stdout + stderr,
        }),
    ),
  );

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

// Each path segment and query value of a request, bare, as a server echoing
// the key it rejects would quote it, not the path or query as sent.
const quotedOf = (req: IncomingMessage) => {
  const url = new URL(req.url ?? "/", "http://echo");
  return [
    ...url.pathname.split("/").filter(Boolean),
    ...url.searchParams.values(),
  ].join(" ");
};

const echo500 = () =>
  createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: `rejected ${quotedOf(req)}` },
      }),
    );
  });

// A 200 whose reorg record holds the quote as its height, which fails the
// schema. Zod 4 leaves the input out of its error, so this guards a parser
// that names the value it refused.
const echo200 = () =>
  createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          orphanedBlockHash: "0x01",
          height: quotedOf(req),
          timestamp: 0,
          nbrOfOrphanedBlocks: 1,
        },
      ]),
    );
  });

describe("compare-chain against a failing or echoing node or API", () => {
  let server: Server;
  let echoPort: number;
  let closedPort: number;

  beforeAll(async () => {
    const probe = createServer();
    closedPort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    server = echo500();
    echoPort = await listen(server);
  });

  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  it("prints a fixed diagnostic, without a credential or the host", async () => {
    const urls = (port: number, userinfo: string) => ({
      node: `http://${userinfo}127.0.0.1:${port}/${PATH}?key=${QUERY}`,
      api: `http://${userinfo}127.0.0.1:${port}/${PATH}`,
    });
    // fetch refuses a URL with userinfo before it connects, so only the
    // closed port gets one and the echoing server sees the path and query.
    const setups = [
      { port: closedPort, ...urls(closedPort, `${USER}:${PASSWORD}@`) },
      { port: echoPort, ...urls(echoPort, "") },
    ];
    for (const { port, node, api } of setups) {
      for (const [check, failed] of [
        ["window", "node getChainTips failed"],
        ["sample", "API /l2/latest-height"],
      ] as const) {
        const { code, output } = await run(check, node, api);
        const at = `${check} against port ${port}`;
        expect.soft(code, `${at}: exit code`).toBe(2);
        expect.soft(output, `${at}: diagnostic`).toContain(failed);
        for (const fragment of [...KEYS, "127.0.0.1", `:${port}`]) {
          expect.soft(output, `${at}: output`).not.toContain(fragment);
        }
      }
    }
    expect(
      (await run("window", setups[1].node, setups[1].api)).output,
      "the status, from the SDK's message",
    ).toContain("node getChainTips failed: HTTP 500");
  }, 60_000);

  it("prints fixed text for a 200 it cannot parse, without the value it echoed", async () => {
    const ok = echo200();
    const port = await listen(ok);
    const node = `http://127.0.0.1:${port}/${PATH}?key=${QUERY}`;
    const api = `http://127.0.0.1:${port}/${PATH}`;
    try {
      for (const [check, failed] of [
        ["reorgs", "API /l2/reorgs: invalid response"],
        ["sample", "API /l2/latest-height: invalid response"],
        ["window", "node getChainTips failed"],
      ] as const) {
        const { code, output } = await run(check, node, api);
        expect.soft(code, `${check}: exit code`).toBe(2);
        expect.soft(output, `${check}: diagnostic`).toContain(failed);
        for (const fragment of [PATH, QUERY, "127.0.0.1", `:${port}`]) {
          expect.soft(output, `${check}: output`).not.toContain(fragment);
        }
      }
    } finally {
      ok.closeAllConnections();
      ok.close();
    }
  }, 60_000);

  it("redacts a key that the API echoes inside a valid answer", async () => {
    // Hex, so it passes as a block hash; in capitals, as hashes print in
    // lowercase.
    const key = "5C1EA7E5".repeat(4);
    const block = loadFixture("local-network", "api-body", "block-by-height")
      .data.body as Record<string, unknown>;
    const echoing = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://api");
      const [quoted, ...route] = url.pathname.split("/").filter(Boolean);
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          route.join("/") === "l2/latest-height"
            ? 3
            : Array.from({ length: to - from }, (_, i) => ({
                ...block,
                height: String(from + i),
                hash: `0x${quoted}`,
              })),
        ),
      );
    });
    const port = await listen(echoing);
    const node = await startScriptedNode({
      rpcPort: 0,
      controlPort: 0,
      log: () => undefined,
    });
    try {
      const { code, output } = await run(
        "sample",
        node.rpcUrl,
        `http://127.0.0.1:${port}/${key}`,
      );
      expect.soft(code, "exit code").toBe(1);
      expect.soft(output, "the mismatch").toContain('"firstMismatch":{');
      expect(output.toLowerCase()).not.toContain(key.toLowerCase());
    } finally {
      await node.close();
      echoing.closeAllConnections();
      echoing.close();
    }
  }, 60_000);

  it("gives up on a node or an API that never answers", async () => {
    const silent = createServer(() => {
      // Never answers.
    });
    const port = await listen(silent);
    const url = `http://127.0.0.1:${port}`;
    try {
      for (const [check, failed] of [
        ["window", "node getChainTips failed: timed out"],
        ["sample", "API /l2/latest-height: timed out"],
      ] as const) {
        const started = Date.now();
        const { code, output } = await run(check, url, url, {
          COMPARE_TIMEOUT_MS: "500",
        });
        expect.soft(code, `${check}: exit code`).toBe(2);
        expect.soft(output, `${check}: diagnostic`).toContain(failed);
        expect.soft(Date.now() - started, `${check}: ms`).toBeLessThan(20_000);
      }
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  }, 60_000);
});
