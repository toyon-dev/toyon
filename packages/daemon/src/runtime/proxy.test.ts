import { describe, expect, test } from "bun:test";
import { startProxy } from "./proxy.ts";

// A real upstream that compresses, because the bug only appears when fetch() decodes a body and
// the upstream's content-encoding survives onto the response the browser gets.
function upstream(body: string, contentType: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response(Bun.gzipSync(new TextEncoder().encode(body)), {
        headers: { "content-type": contentType, "content-encoding": "gzip" },
      });
    },
  });
}

// startProxy reports the port it was asked for, so pick a free one rather than passing 0
function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port ?? 0;
  s.stop(true);
  return p;
}

function proxyTo(port: number) {
  return startProxy({ port: freePort(), bridgeScript: () => "", getTarget: () => ({ port, host: "127.0.0.1" }) });
}

/** an upstream that either takes websockets (greeting on open, echoing after) or refuses them the
 * way an app with an auth check does */
function wsUpstream(accept: boolean) {
  return Bun.serve<undefined, string>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (!accept) return new Response("unauthorized", { status: 401 });
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send("greeting");
      },
      message(ws, m) {
        ws.send(`echo:${String(m)}`);
      },
    },
  });
}

describe("preview proxy", () => {
  test("a compressed asset arrives decodable, not labelled gzip with a decoded body", async () => {
    const js = `console.log(${JSON.stringify("x".repeat(5000))});`;
    const up = upstream(js, "application/javascript");
    const proxy = proxyTo(up.port ?? 0);
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/app.js`, {
        headers: { "accept-encoding": "gzip, deflate, br" },
      });
      // Either the body is genuinely encoded as the header claims, or the header is gone. Claiming
      // gzip over a decoded body is what makes a browser discard the resource.
      if (res.headers.get("content-encoding") === "gzip") {
        expect(new Uint8Array(await res.clone().arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
      }
      expect(await res.text()).toBe(js);
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });

  test("html still gets the bridge injected and loses its stale encoding header", async () => {
    const up = upstream("<html><head></head><body>hi</body></html>", "text/html; charset=utf-8");
    const proxy = proxyTo(up.port ?? 0);
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { "accept-encoding": "gzip, deflate, br" },
      });
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toContain("hi");
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });

  // An open that closes reads as success to every reconnecting client: it resets the backoff and
  // the retry becomes a hot loop, with whatever it sent in between dropped in the proxy.
  test("a websocket the app refuses fails the handshake instead of opening first", async () => {
    const up = wsUpstream(false);
    const proxy = proxyTo(up.port ?? 0);
    const seen: string[] = [];
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/socket`);
      const done = Promise.withResolvers<void>();
      ws.onopen = () => seen.push("open");
      ws.onerror = () => {
        seen.push("error");
        done.resolve();
      };
      ws.onclose = () => {
        seen.push("close");
        done.resolve();
      };
      const bail = setTimeout(() => done.resolve(), 3000);
      await done.promise;
      clearTimeout(bail);
      ws.close();
      expect(seen).not.toContain("open");
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });

  test("an accepted websocket bridges both ways, including what the upstream says on connect", async () => {
    const up = wsUpstream(true);
    const proxy = proxyTo(up.port ?? 0);
    const got: string[] = [];
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/socket`);
      const done = Promise.withResolvers<void>();
      // the greeting is sent before this client's handshake finishes: it only arrives if the
      // proxy held it while the browser side was still connecting
      ws.onmessage = (e) => {
        got.push(String(e.data));
        if (got.length === 2) done.resolve();
      };
      ws.onopen = () => ws.send("ping");
      ws.onerror = () => done.resolve();
      const bail = setTimeout(() => done.resolve(), 3000);
      await done.promise;
      clearTimeout(bail);
      ws.close();
      expect(got).toEqual(["greeting", "echo:ping"]);
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });
});
