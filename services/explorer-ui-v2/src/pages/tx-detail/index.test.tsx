import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const TX = `0x${"cd".repeat(32)}`;
const BLOCK = `0x${"ab".repeat(32)}`;
const found = vi.hoisted(() => ({
  effect: undefined as unknown,
  pending: null as unknown,
  dropped: null as unknown,
}));

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
  usePendingTxsByHash: () => ({ data: found.pending }),
  useGetTxEffectByHash: () => ({ data: found.effect }),
  useDroppedTxByHash: () => ({ data: found.dropped }),
  usePublicCallRequestsByTxHash: () => ({ data: [] }),
  useChainInfo: () => ({ data: undefined }),
}));

// The components read these from the env at import.
vi.stubEnv("VITE_L2_NETWORK_ID", "SANDBOX");
vi.stubEnv("VITE_API_URL", "https://api.test");
vi.stubEnv("VITE_API_KEY", "dev-api-key");

const { TxDetailPage } = await import("./index");

// Each panel by the API path its head names.
const PANELS = { pending: "/api/l2/txs/", dropped: "/api/l2/dropped-txs/" };

// What the lookups hold for the tx: its effect (in a block on the chain, or
// only in an orphaned one), and whether it has a pending and a dropped row.
const render = ({
  effect,
  pending = false,
  dropped = false,
}: {
  effect?: "mined" | "orphaned";
  pending?: boolean;
  dropped?: boolean;
}) => {
  found.effect = effect && {
    txHash: TX,
    blockHash: BLOCK,
    blockHeight: 7n,
    timestamp: 1_700_000_000_000,
    isOrphaned: effect === "orphaned",
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
  found.pending = pending
    ? { txHash: TX, feePayer: BLOCK, birthTimestamp: 1_700_000_000_000 }
    : null;
  found.dropped = dropped
    ? {
        txHash: TX,
        createdAsPendingAt: 1_700_000_000_000,
        droppedAt: 1_700_000_100_000,
        dropReason: "expired",
      }
    : null;
  const html = renderToStaticMarkup(<TxDetailPage />);
  return {
    status: /class="status-pill (\w+)"/.exec(html)?.[1],
    blockLinks: [...html.matchAll(/href="\/blocks\/([^"]+)"/g)].map(
      ([, block]) => block,
    ),
    droppedAt: html.includes("dropped at "),
    panels: Object.entries(PANELS)
      .filter(([, path]) => html.includes(path))
      .map(([panel]) => panel),
    notFound: html.includes("tx not found"),
  };
};

describe("TxDetailPage", () => {
  it("shows a tx whose effect only an orphaned block keeps as not mined, and links that block by hash", () => {
    expect(render({ effect: "orphaned" })).toEqual({
      status: "orphaned",
      blockLinks: [BLOCK, BLOCK, BLOCK],
      droppedAt: false,
      panels: [],
      notFound: false,
    });
  });

  it("shows a mined tx as mined, links its block by hash, and shows no drop it once had", () => {
    expect(render({ effect: "mined", dropped: true })).toEqual({
      status: "mined",
      blockLinks: [BLOCK, BLOCK, BLOCK],
      droppedAt: false,
      panels: [],
      notFound: false,
    });
  });

  it("shows a dropped tx's drop, not the pending row it still has", () => {
    expect(render({ pending: true, dropped: true })).toEqual({
      status: "dropped",
      blockLinks: [],
      droppedAt: true,
      panels: ["dropped"],
      notFound: false,
    });
  });

  it("shows a pending tx's pending row", () => {
    expect(render({ pending: true })).toEqual({
      status: "pending",
      blockLinks: [],
      droppedAt: false,
      panels: ["pending"],
      notFound: false,
    });
  });
});
