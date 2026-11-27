import {
  type ChicmozL2TxEffectDeluxe,
  type UiTxEffectTable,
} from "@chicmoz-pkg/types";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { TxEffectsAPI } from "~/api";
import {
  LIVE_REFETCH_INTERVAL,
  REFETCH_INTERVAL,
  SLOW_REFETCH_INTERVAL,
  queryKeyGenerator,
} from "./utils";

export const useGetTxEffectByHash = (
  hash: string,
  refetchUntilFound = false,
): UseQueryResult<ChicmozL2TxEffectDeluxe, Error> => {
  return useQuery<ChicmozL2TxEffectDeluxe, Error>({
    queryKey: queryKeyGenerator.txEffectByHash(hash),
    queryFn: () => TxEffectsAPI.getTxEffectByHash(hash),
    enabled: !!hash,
    // Detail queries poll, since catch-up blocks index and move effects and
    // fill blocks' txs with no websocket frame.
    refetchInterval: ({ state }) =>
      !state.data
        ? refetchUntilFound
          ? LIVE_REFETCH_INTERVAL
          : SLOW_REFETCH_INTERVAL
        : state.data.isOrphaned
          ? REFETCH_INTERVAL
          : SLOW_REFETCH_INTERVAL,
    staleTime: 5 * 60_000,
  });
};

export const useGetTxEffectsByBlockHeight = (
  height: bigint | string | number | undefined,
): UseQueryResult<ChicmozL2TxEffectDeluxe[], Error> => {
  return useQuery<ChicmozL2TxEffectDeluxe[], Error>({
    queryKey: queryKeyGenerator.txEffectsByBlockHeight(height),
    queryFn: () =>
      !height
        ? Promise.resolve([])
        : TxEffectsAPI.getTxEffectsByBlockHeight(BigInt(height)),
    enabled: height !== undefined,
    staleTime: 5 * 60_000,
  });
};

export const useGetTableTxEffectsByBlockHeight = (
  height: bigint | string | number | undefined,
): UseQueryResult<UiTxEffectTable[], Error> => {
  return useQuery<UiTxEffectTable[], Error>({
    queryKey: queryKeyGenerator.txEffectsByBlockHeight(height),
    queryFn: () =>
      !height
        ? Promise.resolve([])
        : TxEffectsAPI.getTableTxEffectsByBlockHeight(BigInt(height)),
    enabled: height !== undefined,
    refetchInterval: SLOW_REFETCH_INTERVAL,
    staleTime: 5 * 60_000,
  });
};

export const useLatestTableTxEffects = (): UseQueryResult<
  UiTxEffectTable[],
  Error
> => {
  return useQuery<UiTxEffectTable[], Error>({
    queryKey: queryKeyGenerator.latestTableTxEffects,
    queryFn: () => TxEffectsAPI.getLatestTableTxEffect(),
    refetchInterval: REFETCH_INTERVAL,
  });
};
