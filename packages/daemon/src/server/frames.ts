// The frame origin: rendered html pages, each by its ticket (core/frames.ts), on an origin that
// holds no token and no shell. Every answer here, a 404 included, carries a policy that starts with
// `sandbox`, so nothing served from this origin ever runs as this origin: a document here is opaque
// to itself and to everything else. The one listener runs on its own loopback port, and under a
// public name the same handler answers for the frame authority, routed by name on the daemon's
// listener or on its own forwarded port (shared/daemon.ts, frameAuthority).

import { addressedByPort, FRAME_PORT, frameAuthority, type Remote } from "@toyon/shared";
import { cloud } from "../core/cloud.ts";
import type { FrameTickets } from "../core/frames.ts";
import { log } from "../core/log.ts";
import { door } from "../core/remote.ts";
import { allocatePort } from "../runtime/ports.ts";

export interface FrameDeps {
  tickets: FrameTickets;
  /** who may frame a page: the origins this daemon serves a shell from or has let in, and the
   * ones a shell has actually come from (bridge-script.ts) */
  shells: () => { own: string[]; learned: string[] };
}

/** what a browser says it is loading, for the page and for a file: a leaked address opened as a tab
 * or fetched by a script is neither. An old browser that says nothing is let through: the policy
 * below holds either way, and curl was never going to say. */
const PAGE_DESTS = new Set(["iframe"]);
const FILE_DESTS = new Set(["image", "style", "font", "video", "audio", "track", "object"]);
const FONT = /\.(woff2?|ttf|otf)$/i;

/** every feature a page could ask the browser for, denied */
const PERMISSIONS = [
  "accelerometer",
  "camera",
  "display-capture",
  "fullscreen",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "picture-in-picture",
  "publickey-credentials-get",
  "screen-wake-lock",
  "usb",
  "xr-spatial-tracking",
]
  .map((f) => `${f}=()`)
  .join(", ");

/** The page's policy. What it stops: reading any response back (`connect-src`), reaching this
 * machine's servers over plain http, a frame inside the frame, a form, a base that moves the
 * page's addresses. What it allows: the page's own files from `origin`, and scripts, styles,
 * pictures and fonts from the web, since the frame holds nothing those could carry off. The shells
 * alone may frame it. The policy grammar has no IPv6 literal, so a shell at `http://[::1]:<port>`
 * cannot be named: one merely listed (the dev port, always on the list) is left out, and one a
 * shell has actually come from leaves the directive off rather than shutting that shell out. The
 * ticket is the capability, and the page is opaque to whoever frames it. */
export function pagePolicy(origin: string, shells: { own: string[]; learned: string[] }): string {
  const nameable = (a: string) => !a.includes("[");
  const named = [...shells.own, ...shells.learned].filter(nameable);
  const blind = shells.learned.some((a) => !nameable(a));
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:",
    `style-src 'unsafe-inline' data: https: ${origin}`,
    `img-src data: blob: https: ${origin}`,
    `font-src data: https: ${origin}`,
    `media-src data: blob: https: ${origin}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    ...(blind ? [] : [`frame-ancestors ${named.length ? named.join(" ") : "'none'"}`]),
  ].join("; ");
}

/** the headers every answer from this origin carries; the policy is the page's or the bare sandbox */
export function harden(res: Response, policy = "sandbox"): Response {
  const h = new Headers(res.headers);
  h.set("content-security-policy", policy);
  h.set("x-content-type-options", "nosniff");
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "no-referrer");
  h.set("permissions-policy", PERMISSIONS);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const notFound = () => harden(new Response("not found", { status: 404 }));

export interface FrameHandler {
  /** the answer for `req`, reached as `origin` (`http://127.0.0.1:<port>`, `https://frames.<host>`) */
  fetch(req: Request, origin: string): Promise<Response>;
}

export function frameHandler(deps: FrameDeps): FrameHandler {
  return {
    async fetch(req, origin) {
      if (req.method !== "GET" && req.method !== "HEAD") return harden(new Response("method", { status: 405 }));
      const url = new URL(req.url);
      const [code = "", ...rest] = url.pathname.slice(1).split("/");
      if (!/^[A-Za-z0-9_-]{22}$/.test(code)) return notFound();
      const ticket = deps.tickets.get(code);
      if (!ticket) return notFound();
      const key = decodeKey(rest);
      if (key === null) return notFound();
      const isPage = key === ticket.page;
      const dest = req.headers.get("sec-fetch-dest");
      if (dest && !(isPage ? PAGE_DESTS : FILE_DESTS).has(dest)) return notFound();
      const found = await deps.tickets.file(ticket, key);
      if (!found) return notFound();
      if (isPage) {
        const body = "text" in found ? found.text : Bun.file(found.path);
        const res = new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
        return harden(res, pagePolicy(origin, deps.shells()));
      }
      // a file: Bun names its type by the extension and answers a Range on its own, which Safari
      // needs before it plays a clip. A font is fetched with CORS by the opaque document, so fonts
      // alone are open to any origin; a picture is not, or a canvas could read its pixels.
      const res = new Response(Bun.file(("path" in found && found.path) || ""), {
        headers: FONT.test(key) ? { "access-control-allow-origin": "*" } : {},
      });
      return harden(res);
    },
  };
}

/** the key a request's path segments name, each decoded; null for an escape that is not one */
function decodeKey(segs: string[]): string | null {
  try {
    const key = segs.map(decodeURIComponent).join("/");
    return key === "" ? null : key;
  } catch {
    return null;
  }
}

/** the frame listener: ephemeral on loopback, or on the fixed port a port-addressed front forwards */
export class FrameListener {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number | null = null;
  /** why there is no listener, for the shell to read; null while there is one */
  private why: string | null = null;

  readonly handler: FrameHandler;

  constructor(
    private d: {
      handler: FrameHandler;
      remote: () => Remote | null;
    },
  ) {
    this.handler = d.handler;
  }

  /** the local frame origin, or null while nothing listens */
  origin(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}`;
  }

  /** what the shell is told when there is no origin to frame at */
  reason(): string {
    return this.why ?? "the frame origin is not up";
  }

  /** Bind where the public name wants: its own port when previews have their own (the front
   * forwards it), the ephemeral port otherwise. Called at boot and when the name changes. */
  async follow(): Promise<void> {
    const r = this.d.remote();
    const fixed = r !== null && addressedByPort(r.previews);
    if (this.server && (fixed ? this.port === FRAME_PORT : this.port !== FRAME_PORT)) return;
    this.stop();
    const port = fixed ? FRAME_PORT : await allocatePort();
    try {
      this.server = Bun.serve({
        port,
        hostname: cloud.bindHost,
        development: false,
        fetch: async (req, srv) => {
          const d = door(req, srv.requestIP(req)?.address ?? "", this.d.remote(), "frame");
          if (d.kind === "refused") return harden(d.response);
          // the authority the door matched, not the Host as sent: a front may drop the port from it
          const r = this.d.remote();
          const origin = d.kind === "frame" && r ? `https://${frameAuthority(r)}` : `http://127.0.0.1:${port}`;
          return this.d.handler.fetch(req, origin);
        },
        // Bun's own error page would be a document on this origin without the sandbox
        error: (e) => {
          log.warn("frames", "a frame request failed", e);
          return harden(new Response("error", { status: 500 }));
        },
      });
      this.port = port;
      this.why = null;
    } catch (e) {
      this.port = null;
      this.why = `port ${port} is taken, and the front forwards that one for rendered pages`;
      log.error("frames", this.why, e);
    }
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.port = null;
  }
}

/** the frame origin for a shell by how it came in: a local one frames at the loopback listener, a
 * remote one at the frame authority its front forwards; null while there is none */
export function frameOriginFor(kind: "local" | "shell", remote: Remote | null, local: string | null): string | null {
  if (kind === "local") return local;
  return remote && `https://${frameAuthority(remote)}`;
}
