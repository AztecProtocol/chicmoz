import { once } from "node:events";
import { type AddressInfo, createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { handleConnection } from "./connection.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn } }));

const UPGRADE_REQUEST =
  "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
// FIN, reserved opcode 0x3, masked, empty payload, zero mask key.
const RESERVED_OPCODE_FRAME = new Uint8Array([0x83, 0x80, 0, 0, 0, 0]);

describe("handleConnection", () => {
  let server: WebSocketServer;

  afterEach(async () => {
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  it("closes a client socket on a protocol error and keeps serving others", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const serverSide: WebSocket[] = [];
    server.on("connection", (socket) => {
      handleConnection(server, socket);
      serverSide.push(socket);
    });
    const { port } = server.address() as AddressInfo;

    const raw = createConnection({ host: "127.0.0.1", port });
    await once(raw, "connect");
    raw.write(UPGRADE_REQUEST);
    const [handshake] = (await once(raw, "data")) as [Buffer];
    expect(handshake.toString()).toMatch(/^HTTP\/1\.1 101 /);

    raw.write(RESERVED_OPCODE_FRAME);
    const [closeFrame] = (await once(raw, "data")) as [Buffer];
    expect(closeFrame[0]).toBe(0x88);
    expect(closeFrame.readUInt16BE(2)).toBe(1002);
    expect(warn).toHaveBeenCalledOnce();

    // Only after the error: `once` rejects if "error" fires while it waits.
    const serverSideClosed = once(serverSide[0], "close");
    raw.destroy();
    await serverSideClosed;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, "open");
    const received = once(client, "message");
    for (const socket of server.clients) {
      socket.send("update");
    }
    const [data] = (await received) as [Buffer];
    expect(data.toString()).toBe("update");
    client.close();
  });
});
