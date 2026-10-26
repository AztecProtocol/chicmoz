import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveJobCountByIp: vi.fn(),
  publishMessage: vi.fn(),
}));

vi.mock("../../src/environment.js", () => ({ ARCHIVE_MODE: true }));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/svcs/database/index.js", () => ({
  controllers: {
    l2Contract: { getActiveJobCountByIp: mocks.getActiveJobCountByIp },
  },
}));
vi.mock("../../src/svcs/message-bus/index.js", () => ({
  publishMessage: mocks.publishMessage,
}));

describe("POST_VERIFY_SOURCE in archive mode", () => {
  it("refuses with 503 before touching the database or Kafka", async () => {
    const { POST_VERIFY_SOURCE } = await import(
      "../../src/svcs/http-server/routes/controllers/source-verification.js"
    );
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const req = {
      ip: "127.0.0.1",
      params: {
        contractClassId: `0x${"1".repeat(64)}`,
        version: "1",
      },
      body: { githubUrl: "https://github.com/AztecProtocol/example" },
    };
    const next = vi.fn();

    // express-async-handler does not return the handler's promise.
    POST_VERIFY_SOURCE(req as never, res as never, next);
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(503));

    expect(next).not.toHaveBeenCalled();
    expect(mocks.getActiveJobCountByIp).not.toHaveBeenCalled();
    expect(mocks.publishMessage).not.toHaveBeenCalled();
  });
});
