// Per-worktree reverse proxy: the preview iframe points here.
// - forwards HTTP to the worktree's preview proc
// - bridges WebSocket upgrades both ways (Vite HMR, app sockets)
// - injects the bridge script into text/html responses
// - serves the bridge script itself at /__orchardist/bridge.js

import type { ServerWebSocket } from "bun";

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

export function startProxy(opts: {
  port: number;
  bridgeScript: () => string;
  /** returns current upstream port for the preview proc, or null if not ready */
  getTarget: () => number | null;
  /** message from the injected bridge script (element picker etc.) */
  onBridgeMessage?: (msg: unknown) => void;
}): WorktreeProxy {
  let target = opts.getTarget();

  const server = Bun.serve<BridgeData, string>({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      target = opts.getTarget();

      if (url.pathname === "/__orchardist/bridge.js") {
        return new Response(opts.bridgeScript(), {
          headers: { "content-type": "text/javascript" },
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
        const upstreamUrl = `ws://127.0.0.1:${target}${url.pathname}${url.search}`;
        const ok = srv.upgrade(req, {
          data: { queue: [], upstream: undefined, upstreamUrl, protocol: proto },
        });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      // Plain HTTP forward
      const upstreamUrl = `http://127.0.0.1:${target}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("host", `127.0.0.1:${target}`);
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
        upstream.onclose = (ev) => { try { ws.close(ev.code, ev.reason); } catch {} };
        upstream.onerror = () => { try { ws.close(1011, "upstream error"); } catch {} };
      },
      message(ws: ServerWebSocket<BridgeData>, message) {
        const up = ws.data.upstream;
        const payload: string | Uint8Array = typeof message === "string" ? message : message;
        if (up && up.readyState === WebSocket.OPEN) up.send(payload);
        else ws.data.queue.push(payload);
      },
      close(ws: ServerWebSocket<BridgeData>) {
        try { ws.data.upstream?.close(); } catch {}
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
  const tag = `<script src="/__orchardist/bridge.js"></script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  if (html.includes("<body")) return html.replace(/<body([^>]*)>/, `<body$1>${tag}`);
  return html + tag;
}

function waitingPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><style>
  body{background:#32302f;color:#a89984;font:14px/1.6 ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}
  </style></head><body><div>starting dev server…</div></body></html>`;
}
