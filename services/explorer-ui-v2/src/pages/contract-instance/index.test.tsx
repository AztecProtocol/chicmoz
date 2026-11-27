import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const ADDRESS = `0x${"ef".repeat(32)}`;
const found = vi.hoisted(() => ({ instance: undefined as unknown }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useParams: () => ({ address: ADDRESS }),
}));
vi.mock("~/components/layout", () => ({
  Shell: ({ children }: { children: ReactNode }) => children,
  ConsoleHead: () => null,
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/hooks/api", () => {
  const none = () => ({ data: undefined });
  return {
    useContractInstance: () => ({
      data: found.instance,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: () => Promise.resolve(),
    }),
    useContractInstanceBalance: none,
    useContractInstanceBalanceHistory: none,
    useContractInstanceFpcRelationships: none,
    useContractInstanceFpcTransactions: none,
    useChainInfo: none,
    useL2ToL1MsgsByContract: none,
    usePublicCallRequestsByContract: none,
    useL1FeeJuicePortalDepositsByAddress: none,
  };
});

// The components read these from the env at import.
vi.stubEnv("VITE_L2_NETWORK_ID", "SANDBOX");
vi.stubEnv("VITE_API_URL", "https://api.test");
vi.stubEnv("VITE_API_KEY", "dev-api-key");

const { ContractInstancePage } = await import("./index");

const statusOf = (isOrphaned: boolean) => {
  found.instance = {
    address: ADDRESS,
    blockHash: `0x${"ab".repeat(32)}`,
    contractClassId: `0x${"12".repeat(32)}`,
    version: 1,
    deployer: `0x${"34".repeat(32)}`,
    salt: `0x${"56".repeat(32)}`,
    initializationHash: `0x${"78".repeat(32)}`,
    immutablesHash: `0x${"9a".repeat(32)}`,
    isOrphaned,
  };
  const html = renderToStaticMarkup(<ContractInstancePage />);
  return /<span class="k">Status<\/span><span class="v">([^<]*)<\/span>/.exec(
    html,
  )?.[1];
};

describe("ContractInstancePage", () => {
  it("shows whether the instance's deployment is orphaned, as the instance lists do", () => {
    expect([statusOf(true), statusOf(false)]).toEqual(["orphaned", "active"]);
  });
});
