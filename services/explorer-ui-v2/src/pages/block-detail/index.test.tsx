import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const BLOCK = `0x${"ab".repeat(32)}`;
const tx = (byte: string) => `0x${byte.repeat(32)}`;
const [TX_A, TX_B, TX_C] = [tx("0a"), tx("0b"), tx("0c")];
const ONE = (10n ** 18n).toString();
const TWO = (2n * 10n ** 18n).toString();
const shown = vi.hoisted(() => ({
  block: undefined as unknown,
  heightRead: undefined as unknown,
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
    useParams: () => ({ blockNumber: BLOCK }),
  };
});
vi.mock("~/components/layout", () => ({
  Shell: ({ children }: { children: ReactNode }) => children,
  ConsoleHead: () => null,
}));
vi.mock("~/hooks/api", () => ({
  useGetBlockByIdentifier: () => ({ data: shown.block }),
  useGetTableTxEffectsByBlockHeight: () => ({ data: shown.heightRead }),
  useChainInfo: () => ({ data: undefined }),
}));

// The components read these from the env at import.
vi.stubEnv("VITE_L2_NETWORK_ID", "SANDBOX");
vi.stubEnv("VITE_API_URL", "https://api.test");
vi.stubEnv("VITE_API_KEY", "dev-api-key");

const { BlockDetailPage } = await import("./index");
const { formatFees } = await import("~/lib/utils");

// The tx rows, as [tx hash, fee].
const render = ({
  body,
  orphaned,
  heightRead,
}: {
  body: string[];
  orphaned: boolean;
  heightRead: Array<[txHash: string, fee: string]>;
}) => {
  shown.block = {
    hash: BLOCK,
    height: 7n,
    nativeStatus: "proposed",
    orphan: orphaned
      ? { timestamp: 1_700_000_000_000, hasOrphanedParent: false }
      : undefined,
    archive: { root: BLOCK },
    header: {
      lastArchive: { root: BLOCK },
      totalFees: "0",
      totalManaUsed: 0n,
      globalVariables: {
        timestamp: 1_700_000_000n,
        version: 1,
        slotNumber: 1,
        coinbase: BLOCK,
        feeRecipient: BLOCK,
        gasFees: { feePerDaGas: 0, feePerL2Gas: 0 },
      },
    },
    body: { txEffects: body.map((txHash) => ({ txHash })) },
  };
  shown.heightRead = heightRead.map(([txHash, transactionFee]) => ({
    blockNumber: 7n,
    txHash,
    transactionFee,
    timestamp: 1_700_000_000_000,
  }));
  const html = renderToStaticMarkup(<BlockDetailPage />);
  return [
    ...html.matchAll(
      /href="\/tx-effects\/([^"]+)">.*?<span class="num">(.*?)<span/g,
    ),
  ].map(([, txHash, fee]) => [txHash, fee]);
};

describe("BlockDetailPage", () => {
  it("lists an orphaned block's own txs, not those of the block its height now names", () => {
    expect(
      render({
        body: [TX_A],
        orphaned: true,
        heightRead: [
          [TX_B, ONE],
          [TX_C, TWO],
        ],
      }),
    ).toEqual([[TX_A, "—"]]);
  });

  it("lists a block's txs in its order, each with its own fee", () => {
    expect(
      render({
        body: [TX_B, TX_C],
        orphaned: false,
        heightRead: [
          [TX_C, TWO],
          [TX_B, ONE],
        ],
      }),
    ).toEqual([
      [TX_B, formatFees(ONE)],
      [TX_C, formatFees(TWO)],
    ]);
  });
});
