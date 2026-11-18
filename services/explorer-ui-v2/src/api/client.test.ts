import { AxiosError, type AxiosAdapter, type AxiosResponse } from "axios";
import { describe, expect, it, vi } from "vitest";
import client, { ApiError } from "./client";

vi.mock("~/service/constants", () => ({ API_URL: "https://api.test/key" }));

describe("api client", () => {
  it("joins the base URL and drops undefined params", () => {
    expect(
      client.getUri({
        url: "/l2/blocks",
        params: { from: 1, to: undefined },
      }),
    ).toBe("https://api.test/key/l2/blocks?from=1");
  });

  it("maps an error response to ApiError", async () => {
    // A custom adapter must reject on its own: axios applies validateStatus only in its built-in adapters.
    const adapter: AxiosAdapter = (config) => {
      const response: AxiosResponse = {
        data: "boom",
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        config,
      };
      return Promise.reject(
        new AxiosError(
          "Request failed with status code 500",
          AxiosError.ERR_BAD_RESPONSE,
          config,
          {},
          response,
        ),
      );
    };

    const request = client.get("/l2/tips", { adapter });
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status: 500,
      message: "boom",
      type: "API",
    });
  });
});
