import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { REFETCH_INTERVAL } from "./utils";

type RefetchInterval = (query: {
  state: { data?: { isOrphaned: boolean } };
}) => number | false;

const passed = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => {
    passed.options = options;
    return {};
  },
}));
vi.mock("~/api", () => ({ TxEffectsAPI: {} }));

const { useGetTxEffectByHash } = await import("./tx-effect");

// react-query asks for the interval again after each fetch, with its data.
const intervalAfterFetching = (isOrphaned: boolean) => {
  const TxPage = () => {
    useGetTxEffectByHash(`0x${"cd".repeat(32)}`);
    return null;
  };
  renderToStaticMarkup(<TxPage />);
  const { refetchInterval } = passed.options as {
    refetchInterval: RefetchInterval;
  };
  return refetchInterval({ state: { data: { isOrphaned } } });
};

describe("useGetTxEffectByHash", () => {
  it("refetches an effect while only an orphaned block holds it, and stops once it is canonical", () => {
    expect(intervalAfterFetching(true)).toBe(REFETCH_INTERVAL);
    expect(intervalAfterFetching(false)).toBe(false);
  });
});
