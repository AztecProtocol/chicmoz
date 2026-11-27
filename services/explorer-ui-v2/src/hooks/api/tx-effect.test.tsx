import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { REFETCH_INTERVAL, SLOW_REFETCH_INTERVAL } from "./utils";

type RefetchInterval = (query: {
  state: { data?: { isOrphaned: boolean } };
}) => number | false;

const passed = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => {
    passed.options.push(options);
    return {};
  },
}));
vi.mock("~/api", () => ({ BlockAPI: {}, TxEffectsAPI: {} }));

const { useGetBlockByIdentifier } = await import("./block");
const { useGetTableTxEffectsByBlockHeight, useGetTxEffectByHash } =
  await import("./tx-effect");

// The refetchInterval of each query `Page` renders, in call order.
const intervalsOf = (Page: () => null) => {
  passed.options = [];
  renderToStaticMarkup(<Page />);
  return passed.options.map(
    (options) => (options as { refetchInterval: unknown }).refetchInterval,
  );
};

// react-query asks for the interval again after each fetch, with its data.
const intervalAfterFetching = (data?: { isOrphaned: boolean }) => {
  const TxPage = () => {
    useGetTxEffectByHash(`0x${"cd".repeat(32)}`);
    return null;
  };
  const [refetchInterval] = intervalsOf(TxPage) as [RefetchInterval];
  return refetchInterval({ state: { data } });
};

describe("useGetTxEffectByHash", () => {
  it("refetches an orphaned effect every 10 s and a canonical one every minute, but not a missing one", () => {
    expect(intervalAfterFetching({ isOrphaned: true })).toBe(REFETCH_INTERVAL);
    expect(intervalAfterFetching({ isOrphaned: false })).toBe(
      SLOW_REFETCH_INTERVAL,
    );
    expect(intervalAfterFetching()).toBe(false);
  });
});

describe("the block page's queries", () => {
  it("refetch every minute", () => {
    const BlockPage = () => {
      useGetBlockByIdentifier("7");
      useGetTableTxEffectsByBlockHeight(7n);
      return null;
    };
    expect(intervalsOf(BlockPage)).toEqual([
      SLOW_REFETCH_INTERVAL,
      SLOW_REFETCH_INTERVAL,
    ]);
  });
});
