import type { QueryClient } from "@tanstack/react-query";
import { queryKeyGenerator } from "~/hooks/api";

const prefixOf = (queryKey: readonly unknown[]) => queryKey.slice(0, 1);

// Refreshed on a block or tips frame. Either can follow a prune, which changes
// the reorg lists and any block, tx or contract instance already shown: the
// detail and page queries go by prefix, whatever they name.
const CHAIN_QUERIES = [
  queryKeyGenerator.latestBlock,
  queryKeyGenerator.latestTableBlocks,
  queryKeyGenerator.blocksByNativeStatus,
  queryKeyGenerator.l2TipsHealth,
  queryKeyGenerator.reorgs,
  queryKeyGenerator.orphanedBlocks,
  prefixOf(queryKeyGenerator.paginatedTableBlocks(0, 0, undefined)),
  prefixOf(queryKeyGenerator.blockByHeight("")),
  prefixOf(queryKeyGenerator.txEffectsByBlockHeight(undefined)),
  prefixOf(queryKeyGenerator.txEffectByHash("")),
  prefixOf(queryKeyGenerator.pendingTxsByHash("")),
  prefixOf(queryKeyGenerator.droppedTxByHash("")),
  prefixOf(queryKeyGenerator.contractInstance("")),
  prefixOf(queryKeyGenerator.deployedContractInstances("")),
  queryKeyGenerator.latestContractInstances,
];

/**
 * The websocket publisher sends compact payloads such as `{ block }` and
 * `{ txs }`. Older/alternate publishers may send a `{ topic }` envelope, so we
 * keep a case-insensitive topic fallback as well.
 */
export const handleWebSocketMessage = async (
  queryClient: QueryClient,
  raw: string,
): Promise<void> => {
  let parsed: {
    block?: unknown;
    l2Tips?: unknown;
    topic?: string;
    txs?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as {
      block?: unknown;
      l2Tips?: unknown;
      topic?: string;
      txs?: unknown;
    };
  } catch {
    return;
  }

  const topic = parsed.topic?.toLowerCase();
  const hasBlockUpdate =
    parsed.block !== undefined || (topic?.includes("block") ?? false);
  const hasTipsUpdate =
    parsed.l2Tips !== undefined || (topic?.includes("tips") ?? false);
  const hasTxUpdate =
    parsed.txs !== undefined || (topic?.includes("tx") ?? false);
  const hasStatsUpdate = topic?.includes("stats") ?? false;

  if (hasBlockUpdate || hasTipsUpdate) {
    for (const queryKey of CHAIN_QUERIES) {
      await queryClient.invalidateQueries({ queryKey });
    }
  }

  if (hasTxUpdate) {
    await queryClient.invalidateQueries({
      queryKey: queryKeyGenerator.latestTableTxEffects,
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeyGenerator.pendingTxs,
    });
  }

  if (hasStatsUpdate) {
    await queryClient.invalidateQueries({ queryKey: ["stats"] });
  }
};
