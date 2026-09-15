// HTTP side of the daemon: loopback/host guards, /ws auth + upgrade, /health, /register (CLI),
// /attachments (images the shell attached to chat messages), and the static shell. Business logic stays in the services it calls.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Remote } from "@toyon/shared";
import type { Server } from "bun";
import type { AttachmentStore } from "../agent/attachments.ts";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { door, grantCookie, passPreview, previewGrant, sameSecret } from "../core/remote.ts";
import type { RepoRegistry } from "../repos/registry.ts";
import type { PreviewData, PreviewHandler } from "../runtime/proxy.ts";

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
  /** the worktree this socket's tab is showing; null while it shows none or is hidden */
  view: string | null;
  /** set on a socket a remote preview name upgraded: it is bridged to the app, never a shell */
  preview?: { handler: PreviewHandler; data: PreviewData };
}

export interface HttpOpts {
  token: string;
  shellDist: string;
  version: string;
  repos: RepoRegistry;
  attachments: AttachmentStore;
  /** an image from an archived worktree's chat, which the store no longer holds; null when the
   * id or name is not one of ours */
  archivedAttachment: (worktreeId: string, file: string) => string | null;
  /** whether the portless http://toyon.localhost listener came up (known after bind) */
  branded: () => boolean;
  /** event-loop lag + per-socket traffic, for /health */
  metrics: () => unknown;
  /** the origin a shell just authenticated from, for the bridge's list of who may frame a preview */
  noteShellOrigin: (origin: string | null) => void;
  /** the public name and its front (core/remote.ts), or null when the shell is only opened here */
  remote: Remote | null;
  /** a worktree's preview handler, for `w<id>.<remote host>`; null when its proxy is not up */
  preview: (worktreeId: string) => PreviewHandler | null;
  /** the hello frame, for a page that asks before its socket exists */
  bootstrap: () => Promise<unknown>;
  /** ask for a restart; answers a refusal, or null having restarted or queued behind a reply */
  restart: () => string | null;
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
  const grant = previewGrant(opts.token);
  const remote = opts.remote;
  const health = () =>
    Response.json({
      ok: true,
      version: opts.version,
      pid: process.pid,
      branded: opts.branded(),
      remote: remote && { host: remote.host, previews: remote.previews },
      ...(opts.metrics() as object),
    });

  return async function fetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    // Behind an edge, the platform's health check comes from inside its own network and names the
    // machine's address rather than the public name. /health carries nothing a caller could use.
    if (remote?.front === "edge" && url.pathname === "/health") return health();

    const d = door(req, srv.requestIP(req)?.address ?? "", remote, "daemon");
    if (d.kind === "refused") return d.response;
    /** the request came through the front for the shell's own name */
    const remoteShell = d.kind === "shell";

    // A preview name is the app, whole: none of toyon's own routes answer under it. Anyone who can
    // reach the front could otherwise open a dev server, which is a wide surface (dev-only routes,
    // env values in responses, the bundler's file serving), so it takes the grant cookie the shell
    // was given, checked before saying whether the worktree exists.
    if (d.kind === "preview" && d.worktreeId !== null) {
      const pass = passPreview(req, grant);
      if (!pass.ok) return pass.response;
      const handler = opts.preview(d.worktreeId);
      if (!handler) return new Response("no preview is running for this worktree", { status: 404 });
      // the upgrade stays on the original request, which is the one Bun can hand a socket to
      return handler.fetch(pass.req, (data) =>
        srv.upgrade(req, {
          data: {
            authed: false,
            subs: new Set(),
            terms: new Set(),
            dropped: new Set(),
            sent: 0,
            bytes: 0,
            view: null,
            preview: { handler, data },
          },
        }),
      );
    }

    if (url.pathname === "/ws") {
      const authed = sameSecret(url.searchParams.get("token"), opts.token);
      // after the token, never before: this is what teaches the daemon it is being framed
      if (authed) opts.noteShellOrigin(req.headers.get("origin"));
      const data: WsData = {
        authed,
        subs: new Set(),
        terms: new Set(),
        dropped: new Set(),
        sent: 0,
        bytes: 0,
        view: null,
      };
      // a wrong token is still upgraded, then closed with WS_CLOSE_UNAUTHORIZED from `open`: a
      // browser reports a refused handshake as a bare 1006, the same as a daemon that is down, and
      // the shell needs to tell those apart. Nothing is sent on the socket before that close.
      // a shell on the remote name gets the preview grant here too, for a page that reconnects
      // without loading again
      const headers = authed && remote && remoteShell ? { "set-cookie": grantCookie(grant, remote.host) } : undefined;
      if (srv.upgrade(req, { data, headers })) return undefined;
      return new Response(authed ? "upgrade failed" : "unauthorized", { status: authed ? 400 : 401 });
    }

    if (url.pathname === "/health") return health();

    // CLI: register a repo with the running daemon
    // The same frame the socket opens with, fetched by an inline script while the bundle is still
    // loading, so the first paint is the real project and not a placeholder. Token in the query
    // like /ws: the page has it before any of its own code runs.
    if (url.pathname === "/bootstrap") {
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      const headers: Record<string, string> = { "cache-control": NO_STORE };
      // before first paint, so the preview iframes that paint make their first request with it
      if (remote && remoteShell) headers["set-cookie"] = grantCookie(grant, remote.host);
      return Response.json(await opts.bootstrap(), { headers });
    }

    // A page served from files newer than the daemon speaks another protocol and has stopped its
    // socket, so the restart that brings the two level comes over plain HTTP, token in the query
    // like /bootstrap.
    if (url.pathname === "/restart" && req.method === "POST") {
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      const refused = opts.restart();
      return refused ? new Response(refused, { status: 409 }) : new Response(null, { status: 202 });
    }

    if (url.pathname === "/register" && req.method === "POST") {
      if (!sameSecret(req.headers.get("authorization"), `Bearer ${opts.token}`)) {
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
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      const [worktreeId, file, extra] = url.pathname.slice("/attachments/".length).split("/");
      // a removed worktree's chat is shown from the archive, where its images went with it
      const places =
        worktreeId && file && !extra
          ? [opts.attachments.fileFor(worktreeId, file), opts.archivedAttachment(worktreeId, file)]
          : [];
      const path = places.find((p): p is string => !!p && existsSync(p));
      if (!path) return new Response("not found", { status: 404 });
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
    return new Response("Toyon daemon running; shell not built (run: bun run build)", { status: 200 });
  };
}
