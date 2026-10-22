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
const held = {
  document: globals.document,
  window: globals.window,
  WebSocket: globals.WebSocket,
  fetch: globals.fetch,
};

afterEach(() => {
  Object.assign(globals, held);
  HangingSocket.made = [];
});

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

/** a page in front of someone whose every handshake hangs, with the health probe answering as given */
function hanging(health: () => Promise<{ ok: boolean }>) {
  globals.document = { ...idle, visibilityState: "visible" };
  globals.window = idle;
  globals.WebSocket = HangingSocket;
  const probes: string[] = [];
  globals.fetch = (url: string) => {
    probes.push(String(url));
    return health();
  };
  const status: Array<[boolean, unknown]> = [];
  const sock = new DaemonSocket(
    { origin: "https://away.tail1234.ts.net", token: "t" },
    () => {},
    (connected, failure) => status.push([connected, failure]),
    // the test closes each handshake itself, so the order of events is its own and not a race
    // between timers: the deadline never comes, the wait before asking why is 5ms, the retry 5
    // to 10ms out
    { connectDeadline: 2000, settle: 5, backoffMin: 10 },
  );
  return { sock, status, probes };
}

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
      { connectDeadline: 20 },
    );
    const first = HangingSocket.made[0];
    expect(first).toBeDefined();
    await sleep(60);
    // closed from here, once, and the screen told; the retry and the probe follow as for any close
    expect(first?.closes).toBe(1);
    expect(status).toEqual([[false, undefined]]);
    sock.dispose();
  });

  // a phone's first handshake on a cold link outlives the deadline and the retry connects: one
  // drop is not a proxy, and the daemon is not even asked until a second one
  test("one dead handshake with a healthy daemon stays at connecting; the second names the proxy", async () => {
    const { sock, status, probes } = hanging(async () => ({ ok: true }));
    HangingSocket.made[0]?.close();
    await sleep(40);
    // the retry is out and nothing has been asked or said beyond "down, no reason yet"
    expect(HangingSocket.made.length).toBe(2);
    expect(probes).toEqual([]);
    expect(status).toEqual([
      [false, undefined],
      [false, null],
    ]);
    HangingSocket.made[1]?.close();
    await sleep(40);
    expect(probes).toEqual(["https://away.tail1234.ts.net/health"]);
    expect(status.at(-1)).toEqual([false, "blocked"]);
    sock.dispose();
  });

  test("the same two drops with nothing answering over HTTP is an outage, and one drop still is not", async () => {
    const { sock, status, probes } = hanging(() => Promise.reject(new Error("no route")));
    HangingSocket.made[0]?.close();
    await sleep(40);
    expect(probes).toEqual([]);
    expect(status.at(-1)).toEqual([false, null]);
    HangingSocket.made[1]?.close();
    await sleep(40);
    expect(probes.length).toBe(1);
    expect(status.at(-1)).toEqual([false, "down"]);
    sock.dispose();
  });
});
