import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  logger: mocks,
}));

const { handleDuplicateBlockError } = await import(
  "../../src/events/received/utils.js"
);

const duplicate = (detail: string) => ({ code: "23505", detail });
const callbacks = (resolves = true) => ({
  deleteIncomingHeight: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  unOrphan: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  resolveDuplicateTxOwner: vi.fn<() => Promise<boolean>>(() =>
    Promise.resolve(resolves),
  ),
});
const handle = (
  error: { code: string; detail: string },
  cb: ReturnType<typeof callbacks>,
) =>
  handleDuplicateBlockError(
    error,
    "block 9897",
    cb.deleteIncomingHeight,
    cb.unOrphan,
    cb.resolveDuplicateTxOwner,
  );

beforeEach(() => {
  mocks.error.mockClear();
  mocks.info.mockClear();
  mocks.warn.mockClear();
});

describe("handleDuplicateBlockError", () => {
  it("uses the tx owner resolver for duplicate tx_hash errors", async () => {
    const cb = callbacks();

    const outcome = await handle(
      duplicate("Key (tx_hash)=(0xabc) already exists."),
      cb,
    );

    expect(outcome).toBe("retry");
    expect(cb.resolveDuplicateTxOwner).toHaveBeenCalledOnce();
    expect(cb.deleteIncomingHeight).not.toHaveBeenCalled();
    expect(cb.unOrphan).not.toHaveBeenCalled();
  });

  it("skips when the tx owner resolver cannot clear the conflict", async () => {
    await expect(
      handle(
        duplicate("Key (tx_hash)=(0xabc) already exists."),
        callbacks(false),
      ),
    ).resolves.toBe("skip");
  });

  it("keeps the existing height-delete retry path for duplicate height errors", async () => {
    const cb = callbacks();

    const outcome = await handle(
      duplicate("Key (height)=(9897) already exists."),
      cb,
    );

    expect(outcome).toBe("retry");
    expect(cb.deleteIncomingHeight).toHaveBeenCalledOnce();
    expect(cb.resolveDuplicateTxOwner).not.toHaveBeenCalled();
  });

  it("un-orphans an existing block with the same hash, which counts as stored", async () => {
    const cb = callbacks();

    const outcome = await handle(
      duplicate("Key (hash)=(0x0394) already exists."),
      cb,
    );

    expect(outcome).toBe("done");
    expect(cb.unOrphan).toHaveBeenCalledOnce();
  });

  it("does not count a duplicate on an unexpected key as stored", async () => {
    const cb = callbacks();

    const outcome = await handle(
      duplicate("Key (address)=(0x01) already exists."),
      cb,
    );

    expect(outcome).toBe("skip");
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("DB duplicate on an unexpected key"),
    );
    expect(cb.unOrphan).not.toHaveBeenCalled();
    expect(cb.deleteIncomingHeight).not.toHaveBeenCalled();
  });
});
