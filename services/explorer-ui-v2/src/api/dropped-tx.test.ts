import { QueryClient } from "@tanstack/react-query";
import { AxiosError, type AxiosAdapter, type AxiosResponse } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import client from "./client";
import { DroppedTxAPI } from "./dropped-tx";

vi.mock("~/service/constants", () => ({
  API_URL: "https://api.test/key",
  aztecExplorer: {
    getL2DroppedTxByHash: (hash: string) => `/l2/dropped-txs/${hash}`,
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

describe("DroppedTxAPI.getDroppedTxByHash", () => {
  it("answers null once the tx has no dropped row, so a refetch clears the drop it found before", async () => {
    const queryClient = new QueryClient();
    const lookup = {
      queryKey: ["droppedTxByHash", TX],
      queryFn: () => DroppedTxAPI.getDroppedTxByHash(TX),
      retry: false,
    };
    client.defaults.adapter = answer(200, {
      txHash: TX,
      createdAsPendingAt: 1,
      droppedAt: 2,
    });
    await queryClient.fetchQuery(lookup);

    client.defaults.adapter = answer(404, "not found");
    await queryClient.refetchQueries({ queryKey: lookup.queryKey });

    expect(queryClient.getQueryData(lookup.queryKey)).toBeNull();
  });

  it("still fails on any other error", async () => {
    client.defaults.adapter = answer(500, "boom");

    await expect(DroppedTxAPI.getDroppedTxByHash(TX)).rejects.toMatchObject({
      status: 500,
    });
  });
});
