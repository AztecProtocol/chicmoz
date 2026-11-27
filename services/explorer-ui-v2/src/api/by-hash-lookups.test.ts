import { QueryClient } from "@tanstack/react-query";
import { AxiosError, type AxiosAdapter, type AxiosResponse } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import client from "./client";
import { DroppedTxAPI } from "./dropped-tx";
import { TxAPI } from "./tx";

vi.mock("~/service/constants", () => ({
  API_URL: "https://api.test/key",
  aztecExplorer: {
    getL2DroppedTxByHash: (hash: string) => `/l2/dropped-txs/${hash}`,
    getL2PendingTxsByHash: (hash: string) => `/l2/txs/${hash}`,
  },
}));

const TX = `0x${"cd".repeat(32)}`;

// A custom adapter must reject on its own: axios applies validateStatus only in its built-in adapters.
const answer =
  (status: number, data: unknown): AxiosAdapter =>
  (config) => {
    const response: AxiosResponse = {
      data,
      status,
      statusText: "",
      headers: {},
      config,
    };
    return status < 400
      ? Promise.resolve(response)
      : Promise.reject(
          new AxiosError(
            `Request failed with status code ${status}`,
            AxiosError.ERR_BAD_REQUEST,
            config,
            {},
            response,
          ),
        );
  };

const { adapter } = client.defaults;
afterEach(() => {
  client.defaults.adapter = adapter;
});

describe.each([
  {
    name: "DroppedTxAPI.getDroppedTxByHash",
    lookup: DroppedTxAPI.getDroppedTxByHash,
    row: { txHash: TX, createdAsPendingAt: 1, droppedAt: 2 },
  },
  {
    name: "TxAPI.getPendingTxsByHash",
    lookup: TxAPI.getPendingTxsByHash,
    row: { txHash: TX, feePayer: `0x${"0e".repeat(32)}`, birthTimestamp: 1 },
  },
])("$name", ({ name, lookup, row }) => {
  it("answers null once the tx has no row, so a refetch clears the row it found before", async () => {
    const queryClient = new QueryClient();
    const query = {
      queryKey: [name, TX],
      queryFn: (): Promise<unknown> => lookup(TX),
      retry: false,
    };
    client.defaults.adapter = answer(200, row);
    await queryClient.fetchQuery(query);

    client.defaults.adapter = answer(404, "not found");
    await queryClient.refetchQueries({ queryKey: query.queryKey });

    expect(queryClient.getQueryData(query.queryKey)).toBeNull();
  });

  it("still fails on any other error", async () => {
    client.defaults.adapter = answer(500, "boom");

    await expect(lookup(TX)).rejects.toMatchObject({ status: 500 });
  });
});
