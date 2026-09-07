// Per-worktree reverse proxy: the preview iframe points here.
// - forwards HTTP to the worktree's preview proc
// - bridges WebSocket upgrades both ways (Vite HMR, app sockets)
// - injects the bridge script into text/html responses
// - serves the bridge script itself at /__toyon/bridge.js

import type { ServerWebSocket } from "bun";
import { cloud } from "../core/cloud.ts";

interface BridgeData {
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
  upstreamUrl: string;
  protocol?: string;
}

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

      // WebSocket upgrade -> bridge to upstream
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const proto = req.headers.get("sec-websocket-protocol") ?? undefined;
        const upstreamUrl = `ws://${hostPart(target)}:${target.port}${url.pathname}${url.search}`;
        const ok = srv.upgrade(req, {
          data: { queue: [], upstream: undefined, upstreamUrl, protocol: proto },
        });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      // Plain HTTP forward
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
        const { upstreamUrl, protocol } = ws.data;
        const upstream = new WebSocket(upstreamUrl, protocol ? [protocol] : []);
        upstream.binaryType = "arraybuffer";
        ws.data.upstream = upstream;
        upstream.onopen = () => {
          for (const m of ws.data.queue) upstream.send(m);
          ws.data.queue = [];
        };
        upstream.onmessage = (ev) => {
          ws.send(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
        };
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
        const up = ws.data.upstream;
        const payload: string | Uint8Array = typeof message === "string" ? message : message;
        if (up && up.readyState === WebSocket.OPEN) up.send(payload);
        else ws.data.queue.push(payload);
      },
      close(ws: ServerWebSocket<BridgeData>) {
        try {
          ws.data.upstream?.close();
        } catch {
          // upstream never opened
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

function injectBridge(html: string): string {
  // served with cache-control: no-store, so every page load gets the current bridge
  const tag = `<script src="/__toyon/bridge.js"></script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  if (html.includes("<body")) return html.replace(/<body([^>]*)>/, `<body$1>${tag}`);
  return html + tag;
}

// painted with the selected shell theme so the placeholder doesn't flash a foreign color
let waitingColors = { bg: "#32302f", fg: "#a89984" };
export function setWaitingColors(c: { bg: string; fg: string }) {
  waitingColors = c;
}

function waitingPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><style>
  body{background:${waitingColors.bg};color:${waitingColors.fg};font:14px/1.6 ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}
  </style></head><body><div>starting dev server…</div></body></html>`;
}
