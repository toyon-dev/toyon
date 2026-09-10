// HTTP side of the daemon: loopback/host guards, /ws auth + upgrade, /health, /register (CLI),
// /attachments (images the shell attached to chat messages), and the static shell. Business logic stays in the services it calls.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import type { AttachmentStore } from "../agent/attachments.ts";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import type { RepoRegistry } from "../repos/registry.ts";

export interface WsData {
  authed: boolean;
  /** worktree ids this socket receives streams for */
  subs: Set<string>;
  /** the streams this socket has a tab open on, as `worktreeId/stream`; term-data goes only there */
  terms: Set<string>;
  /** streams whose output is being dropped because this socket is behind; one notice each */
  dropped: Set<string>;
  sent: number;
  bytes: number;
}

export interface HttpOpts {
  token: string;
  shellDist: string;
  version: string;
  repos: RepoRegistry;
  attachments: AttachmentStore;
  /** whether the portless http://toyon.localhost listener came up (known after bind) */
  branded: () => boolean;
  /** event-loop lag + per-socket traffic, for /health */
  metrics: () => unknown;
  /** the origin a shell just authenticated from, for the bridge's list of who may frame a preview */
  noteShellOrigin: (origin: string | null) => void;
}

/** a year, and never revalidate: for a name that cannot mean different bytes later */
const IMMUTABLE = "private, max-age=31536000, immutable";
/** vite content-hashes everything under /assets, so those are immutable by construction. Nothing
 * else the shell serves is: index.html is what maps those hashes to the current build, and a
 * cached one boots an asset graph the daemon no longer has. That lands on the stale-build screen
 * whose reload button reads the same cached index again, with no way out. manifest.json, icon.svg
 * and sw.js are unhashed for the same reason, and a cached worker script is slow to replace. */
const NO_STORE = "no-store";

export function createFetch(opts: HttpOpts) {
  return async function fetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    // Cloud mode sits behind the host's TLS edge: peers and Host headers are remote by design,
    // and the bearer token on /ws and /register is the auth.
    if (!cloud.enabled) {
      // the port-80 listener binds wildcard (macOS allows low ports unprivileged only on
      // 0.0.0.0) — so enforce loopback peers on every request
      const ip = srv.requestIP(req)?.address ?? "";
      if (ip !== "127.0.0.1" && ip !== "::1" && !ip.startsWith("::ffff:127.")) {
        return new Response("forbidden", { status: 403 });
      }
      // DNS-rebinding defense: loopback hosts only. *.localhost is safe — browsers hardwire it
      // to loopback and public DNS cannot serve it (RFC 6761).
      const host = (req.headers.get("host") ?? "").split(":")[0] ?? "";
      if (host !== "127.0.0.1" && host !== "localhost" && !host.endsWith(".localhost")) {
        return new Response("forbidden", { status: 403 });
      }
    }

    if (url.pathname === "/ws") {
      const authed = url.searchParams.get("token") === opts.token;
      // a wrong token is still upgraded, then closed with WS_CLOSE_UNAUTHORIZED from `open`: a
      // browser reports a refused handshake as a bare 1006, the same as a daemon that is down, and
      // the shell needs to tell those apart. Nothing is sent on the socket before that close.
      // after the token, never before: this is what teaches the daemon it is being framed
      if (authed) opts.noteShellOrigin(req.headers.get("origin"));
      const data: WsData = { authed, subs: new Set(), terms: new Set(), dropped: new Set(), sent: 0, bytes: 0 };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response(authed ? "upgrade failed" : "unauthorized", { status: authed ? 400 : 401 });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        version: opts.version,
        pid: process.pid,
        branded: opts.branded(),
        ...(opts.metrics() as object),
      });
    }

    // CLI: register a repo with the running daemon
    if (url.pathname === "/register" && req.method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${opts.token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await req.json().catch(() => ({}))) as { path?: string };
      if (!body.path) return new Response("missing path", { status: 400 });
      try {
        const repo = await opts.repos.register(body.path);
        return Response.json({ repoId: repo.id });
      } catch (e) {
        if (e instanceof UserError) return new Response(e.message, { status: 400 });
        log.error("http", "register failed", e);
        return new Response("register failed; see daemon log", { status: 500 });
      }
    }

    // what the shell attached to chat messages (image thumbnails, the text behind a paste chip),
    // back for the transcript. Bun.file types the response from the extension. The token
    // rides in the query like /ws does: an <img src> cannot carry a header. Files never change
    // once written, so the browser may keep them.
    if (url.pathname.startsWith("/attachments/")) {
      if (url.searchParams.get("token") !== opts.token) return new Response("unauthorized", { status: 401 });
      const [worktreeId, file, extra] = url.pathname.slice("/attachments/".length).split("/");
      const path = worktreeId && file && !extra ? opts.attachments.fileFor(worktreeId, file) : null;
      if (!path || !existsSync(path)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path), { headers: { "cache-control": IMMUTABLE } });
    }

    // static shell
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(opts.shellDist, rel.replaceAll("..", ""));
    const hashed = rel.startsWith("/assets/");
    if (existsSync(file) && Bun.file(file).size > 0) {
      return new Response(Bun.file(file), { headers: { "cache-control": hashed ? IMMUTABLE : NO_STORE } });
    }
    // a hashed asset that is gone means the shell was rebuilt under an open tab. Falling through to
    // index.html would answer a module request with HTML, so the import fails on MIME rather than
    // status and the tab can't tell why; 404 lets vite raise preloadError instead.
    if (hashed) return new Response("not found", { status: 404 });
    const index = join(opts.shellDist, "index.html");
    if (existsSync(index)) return new Response(Bun.file(index), { headers: { "cache-control": NO_STORE } });
    return new Response("toyon daemon running; shell not built (run: bun run build)", { status: 200 });
  };
}
