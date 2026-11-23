import { randomUUID } from "node:crypto";
import {
  BaseError,
  type Chain,
  type EIP1193RequestFn,
  type PublicClient,
  RpcRequestError,
  type Transport,
  type WatchContractEventParameters,
  createPublicClient,
  createTransport,
} from "viem";
import { watchContractEvent } from "viem/actions";
import { type SocketRpcClient, getWebSocketRpcClient } from "viem/utils";
import { logger } from "../../logger.js";

/** No usable L1 WebSocket right now; a later request reconnects. */
export class WebSocketUnavailableError extends BaseError {
  constructor(reason: string) {
    super("L1 WebSocket unavailable.", {
      details: reason,
      name: "WebSocketUnavailableError",
    });
  }
}

type RpcClient = SocketRpcClient<WebSocket>;
type RpcResponse = {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const reasonOf = (error: unknown) => {
  if (error instanceof BaseError) {
    return [error.shortMessage, error.details].filter(Boolean).join(" ");
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  // A failed handshake rejects with the socket's error event, which has no message.
  return "connection failed";
};

const isOpen = (rpc: RpcClient) => rpc.socket.readyState === rpc.socket.OPEN;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * A polling-only public client over one L1 WebSocket that survives outages of
 * any length: at most one connection attempt per `reconnectDelayMs`, one live
 * socket, and contract watchers that resume after their last delivered block.
 */
export const createWebSocketClient = ({
  chain,
  url,
  reconnectDelayMs = 2_000,
  reportIntervalMs = 60_000,
}: {
  chain: Chain;
  url: string;
  /** Minimum time between two connection attempts. */
  reconnectDelayMs?: number;
  /** Minimum time between two "still unavailable" log lines. */
  reportIntervalMs?: number;
}) => {
  let live: RpcClient | undefined;
  let dialing: Promise<RpcClient | undefined> | undefined;
  let lastDialAt = Number.NEGATIVE_INFINITY;
  let lastReason = "connection lost";
  let connectedOnce = false;
  let closed = false;
  let outage:
    | { since: number; reportedAt: number; unreported: number }
    | undefined;
  const onReconnect = new Set<() => void>();

  /** Counts one failed request towards the outage report. */
  const unavailable = (reason: string) => {
    const now = Date.now();
    if (!outage) {
      outage = { since: now, reportedAt: now, unreported: 0 };
      logger.error(
        `L1 WebSocket unavailable (${reason}); reconnecting at most every ${reconnectDelayMs} ms`,
      );
    } else if (now - outage.reportedAt >= reportIntervalMs) {
      logger.error(
        `L1 WebSocket still unavailable after ${seconds(now - outage.since)} (last: ${reason}); failed requests since the last report: ${outage.unreported + 1}`,
      );
      outage.reportedAt = now;
      outage.unreported = 0;
    } else {
      outage.unreported++;
    }
    return new WebSocketUnavailableError(reason);
  };

  const evict = (rpc: RpcClient) => {
    if (live !== rpc) {
      return;
    }
    live = undefined;
    rpc.close();
  };

  /** Resolves undefined on failure, with the cause in lastReason. */
  const dial = async () => {
    let rpc: RpcClient;
    try {
      // viem's reconnect gives up after a few attempts, and each failed attempt
      // fires both error and close, so raising the limit grows attempts exponentially.
      rpc = await getWebSocketRpcClient(url, { reconnect: false });
    } catch (error) {
      lastReason = reasonOf(error);
      return undefined;
    }
    if (closed) {
      rpc.close();
      return undefined;
    }
    live = rpc;
    if (outage) {
      logger.info(
        `L1 WebSocket reconnected after ${seconds(Date.now() - outage.since)}; failed requests since the last report: ${outage.unreported}`,
      );
      outage = undefined;
    }
    if (connectedOnce) {
      for (const listener of onReconnect) {
        try {
          listener();
        } catch (error) {
          logger.error(
            `L1 WebSocket reconnect listener failed: ${reasonOf(error)}`,
          );
        }
      }
    }
    connectedOnce = true;
    return rpc;
  };

  /** The live client, the pending dial, or undefined when no dial is due yet. */
  const connect = async () => {
    if (closed) {
      return undefined;
    }
    if (live && isOpen(live)) {
      return live;
    }
    if (live) {
      lastReason = "connection lost";
      evict(live);
    }
    if (!dialing) {
      if (Date.now() - lastDialAt < reconnectDelayMs) {
        return undefined;
      }
      lastDialAt = Date.now();
      dialing = dial().finally(() => {
        dialing = undefined;
      });
    }
    return dialing;
  };

  const transport: Transport = ({ timeout = 10_000 }) => {
    const send = async (body: { method: string; params?: unknown }) => {
      const rpc = await connect();
      if (!rpc) {
        throw unavailable(lastReason);
      }
      try {
        const response: RpcResponse = await rpc.requestAsync({
          body,
          timeout,
        });
        if (response.error) {
          throw new RpcRequestError({ body, error: response.error, url });
        }
        return response.result;
      } catch (error) {
        if (isOpen(rpc)) {
          throw error;
        }
        evict(rpc);
        lastReason = reasonOf(error);
        throw unavailable(lastReason);
      }
    };
    const request = (args: { method: string; params?: unknown }) =>
      args.method === "eth_uninstallFilter"
        ? // viem's watcher cleanup awaits this before it stops its poll loop and
          // never catches, so a rejection keeps the loop alive and goes unhandled.
          send(args).catch((error: unknown) => {
            if (!(error instanceof WebSocketUnavailableError)) {
              logger.warn(
                `eth_uninstallFilter failed, treating the filter as gone: ${reasonOf(error)}`,
              );
            }
            return false;
          })
        : send(args);
    return createTransport({
      key: "webSocket",
      name: "WebSocket JSON-RPC",
      // Not "webSocket": viem would pick eth_subscribe for watchers without a
      // bigint fromBlock, which this transport does not implement.
      type: "pollingWebSocket",
      timeout,
      request: request as EIP1193RequestFn,
    });
  };

  const base = createPublicClient({ chain, transport });

  // After a reconnect the server may have dropped the watcher's filter, and
  // viem re-creates a lost filter from the original fromBlock, so every
  // watcher restarts from the block after the last one it delivered.
  const watchAcrossReconnects = (parameters: WatchContractEventParameters) => {
    let lastDelivered: bigint | undefined;
    const start = () =>
      // viem shares one poll loop per observer id, which includes client.uid; a
      // fresh uid keeps a superseded loop's in-flight poll away from these callbacks.
      watchContractEvent(
        { ...base, uid: randomUUID() },
        {
          ...parameters,
          fromBlock:
            lastDelivered === undefined
              ? parameters.fromBlock
              : lastDelivered + 1n,
          onLogs: (logs) => {
            for (const { blockNumber } of logs) {
              if (
                blockNumber !== null &&
                (lastDelivered === undefined || blockNumber > lastDelivered)
              ) {
                lastDelivered = blockNumber;
              }
            }
            parameters.onLogs(logs);
          },
          onError: (error) => {
            // Already counted in the transport's outage report.
            if (!(error instanceof WebSocketUnavailableError)) {
              parameters.onError?.(error);
            }
          },
        },
      );
    let unwatch = start();
    const restart = () => {
      unwatch();
      unwatch = start();
    };
    onReconnect.add(restart);
    return () => {
      onReconnect.delete(restart);
      unwatch();
    };
  };

  const client = {
    ...base,
    watchContractEvent: watchAcrossReconnects,
  } as PublicClient;

  return {
    client,
    /** Stops reconnecting and closes the live socket. */
    close: () => {
      closed = true;
      lastReason = "client closed";
      onReconnect.clear();
      if (live) {
        evict(live);
      }
    },
  };
};
