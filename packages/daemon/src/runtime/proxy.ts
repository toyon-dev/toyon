// Per-worktree reverse proxy: the preview iframe points here.
// - forwards HTTP to the worktree's preview proc
// - bridges WebSocket upgrades both ways (Vite HMR, app sockets)
// - injects the bridge script into text/html responses
// - serves the bridge script itself at /__toyon/bridge.js
//
// The handler does all of that and owns no listener. Each worktree's own port wraps it
// (`startProxy`), and in remote mode the daemon's listener routes `w<id>.<remote host>` to the same
// handler, so a TLS front forwards one port and holds one wildcard certificate.

import type { Remote } from "@toyon/shared";
import type { ServerWebSocket } from "bun";
import { door, passPreview, setsGrant } from "../core/remote.ts";

export interface PreviewData {
  upstream: WebSocket;
  /** what the upstream said between its own open and the browser's: nothing can receive it yet */
  pending: (string | Uint8Array)[];
}

/** the browser's end of a bridged socket, from whichever listener accepted it */
type BrowserSocket = Pick<ServerWebSocket<unknown>, "send" | "close">;

export interface PreviewHandler {
  /** answers the request, or hands `upgrade` the upstream it dialled and resolves undefined */
  fetch: (req: Request, upgrade: (data: PreviewData) => boolean) => Promise<Response | undefined>;
  open: (ws: BrowserSocket, data: PreviewData) => void;
  message: (data: PreviewData, message: string | Buffer) => void;
  close: (data: PreviewData) => void;
}

/** long enough for any dev server that already answers on its port, short enough that a socket
 * which accepts TCP and then says nothing fails the handshake instead of hanging the request */
const DIAL_TIMEOUT_MS = 5_000;

const frame = (ev: MessageEvent): string | Uint8Array =>
  typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer);

export interface WorktreeProxy {
  port: number;
  /** the listener-free half, for the daemon's own listener to route a remote preview name to */
  handler: PreviewHandler;
  stop: () => void;
  setTarget: (port: number | null) => void;
}

export interface ProxyTarget {
  port: number;
  host: string;
}

export interface PreviewOpts {
  bridgeScript: () => string;
  /** returns current upstream for the preview proc, or null if not ready */
  getTarget: () => ProxyTarget | null;
}

export function previewHandler(opts: PreviewOpts): PreviewHandler {
  const hostPart = (t: ProxyTarget) => (t.host.includes(":") ? `[${t.host}]` : t.host);

  return {
    async fetch(req, upgrade) {
      const url = new URL(req.url);
      const target = opts.getTarget();

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
        if (upgrade({ upstream, pending })) return undefined;
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

      const html = (res.headers.get("content-type") ?? "").includes("text/html");
      // fetch() decompresses transparently but leaves the upstream's content-encoding on the
      // response. Passing that header back with an already decoded body makes the browser try to
      // gunzip plain text: it fails with ERR_CONTENT_DECODING_FAILED and drops the resource, so a
      // preview loads its HTML and none of its script or style.
      const encoded = res.headers.has("content-encoding");
      const cookies = res.headers.getSetCookie();
      const grantSet = cookies.some(setsGrant);
      if (!html && !encoded && !grantSet) return res;
      const h = new Headers(res.headers);
      h.delete("content-length");
      h.delete("content-encoding");
      if (grantSet) {
        h.delete("set-cookie");
        for (const c of cookies) if (!setsGrant(c)) h.append("set-cookie", c);
      }
      if (html) return new Response(injectBridge(await res.text()), { status: res.status, headers: h });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    },

    open(ws, data) {
      const { upstream, pending } = data;
      // it was open when we accepted the handshake; it can still have gone away since
      if (upstream.readyState !== WebSocket.OPEN) {
        ws.close(1011, "upstream closed");
        return;
      }
      for (const m of pending) ws.send(m);
      data.pending = [];
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

    message(data, message) {
      // no queue: the upstream was open before this socket existed, so the only miss is a frame
      // racing the upstream's close, and the close reaches the client right behind it
      if (data.upstream.readyState === WebSocket.OPEN) data.upstream.send(message);
    },

    close(data) {
      try {
        data.upstream.close();
      } catch {
        // already closed from the other side
      }
    },
  };
}

export function startProxy(
  opts: PreviewOpts & {
    port: number;
    /** loopback, or every interface behind an edge where each preview port is a public TLS port */
    hostname: string;
    /** the public name, whose front may forward this port (core/remote.ts) */
    remote: Remote | null;
    /** what a preview reached through the public name must carry */
    grant: string;
    /** message from the injected bridge script (element picker etc.) */
    onBridgeMessage?: (msg: unknown) => void;
  },
): WorktreeProxy {
  const handler = previewHandler(opts);
  const server = Bun.serve<PreviewData, string>({
    port: opts.port,
    hostname: opts.hostname,
    fetch: async (req, srv) => {
      // the same door as the daemon's own listener: a front that addresses previews by port
      // forwards this one, and it gets the same Host, https and grant rules
      const d = door(req, srv.requestIP(req)?.address ?? "", opts.remote, "preview");
      if (d.kind === "refused") return d.response;
      let admitted = req;
      if (d.kind === "preview") {
        const pass = passPreview(req, opts.grant);
        if (!pass.ok) return pass.response;
        admitted = pass.req;
      }
      // the upgrade stays on the original request, which is the one Bun can hand a socket to
      return (await handler.fetch(admitted, (data) => srv.upgrade(req, { data }))) as Response;
    },
    websocket: {
      open: (ws) => handler.open(ws, ws.data),
      message: (ws, message) => handler.message(ws.data, message),
      close: (ws) => handler.close(ws.data),
    },
  });

  return {
    port: opts.port,
    handler,
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
