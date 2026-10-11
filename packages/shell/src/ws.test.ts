import { afterEach, describe, expect, test } from "bun:test";
import { DaemonSocket, daemonUrls } from "./ws.ts";

// Every address the shell fetches from one daemon is built here, absolute, so the same shapes
// reach the machine that served the page and one that let it in.

describe("daemonUrls", () => {
  test("a tailnet machine: https, wss, the token where each route reads it", () => {
    const u = daemonUrls("https://work.tail1234.ts.net", "abc");
    expect(u.origin).toBe("https://work.tail1234.ts.net");
    expect(u.host).toBe("work.tail1234.ts.net");
    expect(u.ws).toBe("wss://work.tail1234.ts.net/ws?token=abc");
    expect(u.attachment("w1", "1.png")).toBe("https://work.tail1234.ts.net/attachments/w1/1.png?token=abc");
    expect(u.upload("u1")).toBe("https://work.tail1234.ts.net/uploads/u1?token=abc");
    expect(u.worktreeFile("w1", "public/a b.png", "v2")).toBe(
      "https://work.tail1234.ts.net/files/w1/public/a%20b.png?token=abc&v=v2",
    );
    expect(u.loose("g1", null)).toBe("https://work.tail1234.ts.net/loose/g1?token=abc&v=");
    expect(u.health).toBe("https://work.tail1234.ts.net/health");
    expect(u.restart(false)).toBe("https://work.tail1234.ts.net/restart?token=abc");
    expect(u.restart(true)).toContain("&now");
    expect(u.uploads("file")).toBe("https://work.tail1234.ts.net/uploads?kind=file");
    expect(u.tailnet).toBe("https://work.tail1234.ts.net/tailnet");
    expect(u.knockAnswer("k1")).toBe("https://work.tail1234.ts.net/knock/k1/answer");
    expect(u.previewGrant).toBe("https://work.tail1234.ts.net/preview-grant");
  });
  test("a loopback daemon on a port: plain ws, the port kept", () => {
    const u = daemonUrls("http://127.0.0.1:4242/", "t");
    expect(u.origin).toBe("http://127.0.0.1:4242");
    expect(u.host).toBe("127.0.0.1");
    expect(u.ws).toBe("ws://127.0.0.1:4242/ws?token=t");
  });
});

// The socket runs on the browser's globals. A test gives it the few it touches: a page that is
// visible, a window with nothing to say, and a WebSocket that never gets past its handshake.
class HangingSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static made: HangingSocket[] = [];
  readyState = HangingSocket.CONNECTING;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closes = 0;
  constructor(readonly url: string) {
    HangingSocket.made.push(this);
  }
  close() {
    if (this.readyState === HangingSocket.CLOSED) return;
    this.closes++;
    // a close while connecting fails the handshake, which the browser reports as 1006
    this.readyState = HangingSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
  send() {}
}

const idle = { addEventListener() {}, removeEventListener() {} };
const globals = globalThis as unknown as Record<string, unknown>;
const held = { document: globals.document, window: globals.window, WebSocket: globals.WebSocket };

afterEach(() => {
  Object.assign(globals, held);
  HangingSocket.made = [];
});

describe("DaemonSocket", () => {
  test("a handshake that hangs is closed at the deadline and reported down", async () => {
    globals.document = { ...idle, visibilityState: "visible" };
    globals.window = idle;
    globals.WebSocket = HangingSocket;
    const status: Array<[boolean, unknown]> = [];
    const sock = new DaemonSocket(
      { origin: "https://away.tail1234.ts.net", token: "t" },
      () => {},
      (connected, failure) => status.push([connected, failure]),
      20,
    );
    const first = HangingSocket.made[0];
    expect(first).toBeDefined();
    await new Promise((f) => setTimeout(f, 60));
    // closed from here, once, and the screen told; the retry and the probe follow as for any close
    expect(first?.closes).toBe(1);
    expect(status).toEqual([[false, undefined]]);
    sock.dispose();
  });
});
