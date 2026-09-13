import { describe, expect, test } from "bun:test";
import type { Remote } from "@toyon/shared";
import { previewGrant } from "../core/remote.ts";
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

function proxyTo(port: number, remote: Remote | null = null) {
  return startProxy({
    port: freePort(),
    hostname: "127.0.0.1",
    remote,
    grant: previewGrant("secret"),
    bridgeScript: () => "",
    getTarget: () => ({ port, host: "127.0.0.1" }),
  });
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

  test("an upstream that sets the grant cookie cannot overwrite it; its own cookies still reach the browser", async () => {
    const up = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("ok", {
          headers: [
            ["set-cookie", "toyon_preview=stolen; Path=/"],
            ["set-cookie", "sid=1; Path=/"],
          ],
        }),
    });
    const proxy = proxyTo(up.port ?? 0);
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
      expect(res.headers.getSetCookie()).toEqual(["sid=1; Path=/"]);
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

// A front that cannot hold a wildcard certificate (tailscale serve, *.fly.dev) forwards each preview
// port as the public name at that port. The port gets the same rules as the daemon's own listener.
describe("preview port behind a port-addressed front", () => {
  const remote: Remote = {
    host: "box.tail1234.ts.net",
    previews: "https://box.tail1234.ts.net:{port}",
    front: "local",
  };
  const grant = previewGrant("secret");
  const through = (proxyPort: number, extra: Record<string, string> = {}) => ({
    host: `box.tail1234.ts.net:${proxyPort}`,
    "x-forwarded-proto": "https",
    ...extra,
  });
  const cookieEcho = () =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new Response(`cookie=${req.headers.get("cookie")}`, { headers: { "content-type": "text/plain" } }),
    });

  test("without the grant, or with a stale one, the preview is refused", async () => {
    const up = cookieEcho();
    const proxy = proxyTo(up.port ?? 0, remote);
    try {
      const bare = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: through(proxy.port) });
      expect(bare.status).toBe(403);
      const stale = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: through(proxy.port, { cookie: `toyon_preview=${previewGrant("old")}` }),
      });
      expect(stale.status).toBe(403);
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });

  test("with the grant it is the app, and the app never sees the grant", async () => {
    const up = cookieEcho();
    const proxy = proxyTo(up.port ?? 0, remote);
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: through(proxy.port, { cookie: `sid=1; toyon_preview=${grant}` }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("cookie=sid=1");
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });

  test("a front that sends the port in x-forwarded-port rather than Host still reaches the app with the grant", async () => {
    const up = cookieEcho();
    const proxy = proxyTo(up.port ?? 0, remote);
    try {
      const headers = {
        host: "box.tail1234.ts.net",
        "x-forwarded-port": String(proxy.port),
        "x-forwarded-proto": "https",
      };
      expect((await fetch(`http://127.0.0.1:${proxy.port}/`, { headers })).status).toBe(403);
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { ...headers, cookie: `toyon_preview=${grant}` },
      });
      expect(res.status).toBe(200);
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });

  test("the name over plain http is refused, and the shell on this machine still frames it by loopback", async () => {
    const up = cookieEcho();
    const proxy = proxyTo(up.port ?? 0, remote);
    try {
      const plain = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { host: `box.tail1234.ts.net:${proxy.port}`, cookie: `toyon_preview=${grant}` },
      });
      expect(plain.status).toBe(403);
      const local = await fetch(`http://127.0.0.1:${proxy.port}/`);
      expect(local.status).toBe(200);
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });

  test("a websocket without the grant is refused before the upstream is dialled", async () => {
    let dialled = false;
    const up = Bun.serve<undefined, string>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        dialled = true;
        return srv.upgrade(req) ? (undefined as unknown as Response) : new Response("no", { status: 400 });
      },
      websocket: { message() {} },
    });
    const proxy = proxyTo(up.port ?? 0, remote);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/socket`, { headers: through(proxy.port) } as never);
      const opened = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        ws.onclose = () => resolve(false);
        setTimeout(() => resolve(false), 3000);
      });
      ws.close();
      expect(opened).toBe(false);
      expect(dialled).toBe(false);
    } finally {
      proxy.stop();
      up.stop(true);
    }
  });
});
