import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const TX = `0x${"cd".repeat(32)}`;
const BLOCK = `0x${"ab".repeat(32)}`;
const found = vi.hoisted(() => ({ effect: undefined as unknown }));

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({
      to,
      params,
      children,
    }: {
      to: string;
      params?: Record<string, string>;
      children: ReactNode;
    }) =>
      createElement(
        "a",
        {
          href: to.replace(
            /\$(\w+)/g,
            (_, name: string) => params?.[name] ?? "",
          ),
        },
        children,
      ),
    useParams: () => ({ hash: TX }),
  };
});
vi.mock("~/components/layout", () => ({
  Shell: ({ children }: { children: ReactNode }) => children,
  ConsoleHead: () => null,
}));
vi.mock("~/hooks/api", () => ({
  usePendingTxsByHash: () => ({ data: undefined }),
  useGetTxEffectByHash: () => ({ data: found.effect }),
  useDroppedTxByHash: () => ({ data: null }),
  usePublicCallRequestsByTxHash: () => ({ data: [] }),
  useChainInfo: () => ({ data: undefined }),
}));

// The components read these from the env at import.
vi.stubEnv("VITE_L2_NETWORK_ID", "SANDBOX");
vi.stubEnv("VITE_API_URL", "https://api.test");
vi.stubEnv("VITE_API_KEY", "dev-api-key");

const { TxDetailPage } = await import("./index");

const render = (isOrphaned: boolean) => {
  found.effect = {
    txHash: TX,
    blockHash: BLOCK,
    blockHeight: 7n,
    timestamp: 1_700_000_000_000,
    isOrphaned,
    transactionFee: "1000",
    revertCode: { code: 0 },
    noteHashes: [],
    nullifiers: [],
    publicDataWrites: [],
    l2ToL1Msgs: [],
    privateLogs: [],
    publicLogs: [],
    contractClassLogs: [],
  };
  const html = renderToStaticMarkup(<TxDetailPage />);
  return {
    status: /class="status-pill (\w+)"/.exec(html)?.[1],
    blockLinks: [...html.matchAll(/href="\/blocks\/([^"]+)"/g)].map(
      ([, block]) => block,
    ),
    notFound: html.includes("tx not found"),
  };
};

describe("TxDetailPage", () => {
  it("shows a tx whose effect only an orphaned block keeps as not mined, and links that block by hash", () => {
    expect(render(true)).toEqual({
      status: "orphaned",
      blockLinks: [BLOCK, BLOCK, BLOCK],
      notFound: false,
    });
  });

  it("links a mined tx's block by height", () => {
    expect(render(false)).toEqual({
      status: "mined",
      blockLinks: ["7", "7", "7"],
      notFound: false,
    });
  });
});
