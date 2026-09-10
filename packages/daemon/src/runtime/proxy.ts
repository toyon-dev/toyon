// Per-worktree reverse proxy: the preview iframe points here.
// - forwards HTTP to the worktree's preview proc
// - bridges WebSocket upgrades both ways (Vite HMR, app sockets)
// - injects the bridge script into text/html responses
// - serves the bridge script itself at /__toyon/bridge.js

import type { ServerWebSocket } from "bun";
import { cloud } from "../core/cloud.ts";

interface BridgeData {
  upstream: WebSocket;
  /** what the upstream said between its own open and the browser's: nothing can receive it yet */
  pending: (string | Uint8Array)[];
}

/** long enough for any dev server that already answers on its port, short enough that a socket
 * which accepts TCP and then says nothing fails the handshake instead of hanging the request */
const DIAL_TIMEOUT_MS = 5_000;

const frame = (ev: MessageEvent): string | Uint8Array =>
  typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer);

export interface WorktreeProxy {
  port: number;
  stop: () => void;
  setTarget: (port: number | null) => void;
}

export interface ProxyTarget {
  port: number;
  host: string;
}

export function startProxy(opts: {
  port: number;
  bridgeScript: () => string;
  /** returns current upstream for the preview proc, or null if not ready */
  getTarget: () => ProxyTarget | null;
  /** message from the injected bridge script (element picker etc.) */
  onBridgeMessage?: (msg: unknown) => void;
}): WorktreeProxy {
  let target = opts.getTarget();
  const hostPart = (t: ProxyTarget) => (t.host.includes(":") ? `[${t.host}]` : t.host);

  const server = Bun.serve<BridgeData, string>({
    port: opts.port,
    // loopback locally; cloud mode exposes each proxy as its own public TLS port
    hostname: cloud.bindHost,
    async fetch(req, srv) {
      const url = new URL(req.url);
      target = opts.getTarget();

      if (url.pathname === "/__toyon/bridge.js") {
        return new Response(opts.bridgeScript(), {
          headers: { "content-type": "text/javascript", "cache-control": "no-store" },
        });
      }

      if (target == null) {
        return new Response(waitingPage(), {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", "retry-after": "2" },
        });
      }

      // WebSocket upgrade: dial the upstream first, and only then accept the browser's handshake.
      // Accepting first turns a socket the app refuses (an auth check on connect, a path it does
      // not serve) into an open that closes immediately. Every reconnecting client reads an open
      // as success and resets its backoff, so it retries in a hot loop instead of standing off,
      // and anything it sent in that window is dropped here with nothing to report it. A refusal
      // has to reach the browser as a refusal.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const proto = req.headers.get("sec-websocket-protocol") ?? undefined;
        const upstreamUrl = `ws://${hostPart(target)}:${target.port}${url.pathname}${url.search}`;
        const pending: (string | Uint8Array)[] = [];
        const upstream = await dial(upstreamUrl, proto, pending);
        if (!upstream) return new Response("the preview's websocket upstream refused it", { status: 502 });
        const ok = srv.upgrade(req, { data: { upstream, pending } });
        if (ok) return undefined as unknown as Response;
        upstream.close();
        return new Response("upgrade failed", { status: 400 });
      }

      const upstreamUrl = `http://${hostPart(target)}:${target.port}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("host", `localhost:${target.port}`);
      headers.delete("accept-encoding"); // keep bodies readable for injection
      let res: Response;
      try {
        res = await fetch(upstreamUrl, {
          method: req.method,
          headers,
          body: req.body,
          redirect: "manual",
        });
      } catch {
        return new Response(waitingPage(), {
          status: 502,
          headers: { "content-type": "text/html; charset=utf-8", "retry-after": "2" },
        });
      }

      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/html")) {
        const html = await res.text();
        const injected = injectBridge(html);
        const h = new Headers(res.headers);
        h.delete("content-length");
        h.delete("content-encoding");
        return new Response(injected, { status: res.status, headers: h });
      }
      // fetch() decompresses transparently but leaves the upstream's content-encoding on the
      // response. Passing that header back with an already decoded body makes the browser try to
      // gunzip plain text: it fails with ERR_CONTENT_DECODING_FAILED and drops the resource, so a
      // preview loads its HTML and none of its script or style. The html branch above already
      // strips it; every other response needs the same treatment.
      if (res.headers.has("content-encoding")) {
        const h = new Headers(res.headers);
        h.delete("content-encoding");
        h.delete("content-length");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      }
      return res;
    },
    websocket: {
      open(ws: ServerWebSocket<BridgeData>) {
        const { upstream, pending } = ws.data;
        // it was open when we accepted the handshake; it can still have gone away since
        if (upstream.readyState !== WebSocket.OPEN) {
          ws.close(1011, "upstream closed");
          return;
        }
        for (const m of pending) ws.send(m);
        ws.data.pending = [];
        upstream.onmessage = (ev) => ws.send(frame(ev));
        upstream.onclose = (ev) => {
          try {
            ws.close(ev.code, ev.reason);
          } catch {
            // already closed by the client
          }
        };
        upstream.onerror = () => {
          try {
            ws.close(1011, "upstream error");
          } catch {
            // already closed by the client
          }
        };
      },
      message(ws: ServerWebSocket<BridgeData>, message) {
        // no queue: the upstream was open before this socket existed, so the only miss is a frame
        // racing the upstream's close, and the close reaches the client right behind it
        const up = ws.data.upstream;
        if (up.readyState === WebSocket.OPEN) up.send(message);
      },
      close(ws: ServerWebSocket<BridgeData>) {
        try {
          ws.data.upstream.close();
        } catch {
          // already closed from the other side
        }
      },
    },
  });

  return {
    port: opts.port,
    stop: () => server.stop(true),
    setTarget: () => {},
  };
}

/** Open the upstream socket, buffering whatever it says before the browser is attached (Vite's
 * HMR server greets on connect). Null when it refuses, closes, or never answers: the caller
 * fails the browser's handshake rather than accepting one it cannot honour. */
async function dial(
  url: string,
  protocol: string | undefined,
  pending: (string | Uint8Array)[],
): Promise<WebSocket | null> {
  const up = new WebSocket(url, protocol ? [protocol] : []);
  up.binaryType = "arraybuffer";
  up.onmessage = (ev) => pending.push(frame(ev));
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), DIAL_TIMEOUT_MS);
    const settle = (v: boolean) => {
      clearTimeout(timer);
      resolve(v);
    };
    up.onopen = () => settle(true);
    up.onerror = () => settle(false);
    up.onclose = () => settle(false);
  });
  if (opened) return up;
  try {
    up.close();
  } catch {
    // refused before there was anything to close
  }
  return null;
}

function injectBridge(html: string): string {
  // served with cache-control: no-store, so every page load gets the current bridge
  const tag = `<script src="/__toyon/bridge.js"></script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  if (html.includes("<body")) return html.replace(/<body([^>]*)>/, `<body$1>${tag}`);
  return html + tag;
}

// painted with the selected shell theme so the placeholder doesn't flash a foreign color
let waitingColors = { bg: "#32302d", fg: "#9e927e" };
export function setWaitingColors(c: { bg: string; fg: string }) {
  waitingColors = c;
}

function waitingPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><style>
  body{background:${waitingColors.bg};color:${waitingColors.fg};font:14px/1.6 ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}
  </style></head><body><div>starting dev server…</div></body></html>`;
}
