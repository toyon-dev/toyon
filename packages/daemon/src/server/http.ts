// HTTP side of the daemon: loopback/host guards, /ws auth + upgrade, /health, /register (CLI),
// /uploads and /attachments (what the shell attached to chat messages), and the static shell. Business logic stays in the services it calls.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isTailnetName,
  type PairMint,
  type PairRedeem,
  pairLink,
  RESTART_NOW,
  type Remote,
  type RestartWait,
  type TailnetPhone,
} from "@toyon/shared";
import type { Server } from "bun";
import { type AttachmentStore, drawnType } from "../agent/attachments.ts";
import { isUploadKind } from "../agent/uploads.ts";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import type { PairCodes } from "../core/pair.ts";
import { door, grantCookie, isLoopbackPeer, passPreview, previewGrant, sameSecret } from "../core/remote.ts";
import type { Opened } from "../files/open.ts";
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
  /** the shell on this socket was opened through the front: from another device */
  remote?: true;
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
  /** a file in a worktree the browser draws (an image), for the editor pane's viewer; null when
   * the path is not one */
  worktreeFile: (worktreeId: string, path: string) => Promise<string | null>;
  /** a granted file the browser draws, by its grant id, for the same viewer; null when the id is
   * not a grant or the file is no picture */
  looseFile: (id: string) => string | null;
  /** whether the portless http://toyon.localhost listener came up (known after bind) */
  branded: () => boolean;
  /** event-loop lag + per-socket traffic, for /health */
  metrics: () => unknown;
  /** the origin a shell just authenticated from, for the bridge's list of who may frame a preview */
  noteShellOrigin: (origin: string | null) => void;
  /** the public name and its front (core/remote.ts), or null when the shell is only opened here */
  remote: Remote | null;
  /** where the managed policy this daemon runs under came from, and a hash of it, so doctor can
   * tell a daemon that booted before IT pushed a newer file */
  managed: { source: string | null; hash: string | null };
  /** a worktree's preview handler, for `w<id>.<remote host>`; null when its proxy is not up */
  preview: (worktreeId: string) => PreviewHandler | null;
  /** the hello frame, for a page that asks before its socket exists */
  bootstrap: () => Promise<unknown>;
  /** a path from outside the shell (the Dock icon, `toyon <path>`): a repo registers, a file
   * opens in its worktree or is granted; a `UserError` is the person's to read */
  open: (path: string) => Promise<Opened>;
  /** ask for a restart; answers a refusal, or null having restarted or queued behind a reply.
   * `now` does not queue. */
  restart: (now: boolean) => Promise<string | null>;
  /** what a requested restart waits on, and the chats it goes past */
  restartWait: () => RestartWait;
  /** the one-time codes a phone trades for the token */
  pair: PairCodes;
  /** a code was just redeemed */
  onPaired: () => void;
  /** the phones on this machine's tailnet; null when Tailscale cannot be asked */
  phones: () => Promise<TailnetPhone[] | null>;
  /** the chosen theme's grounds, for the manifest: the bar a phone draws above an installed shell
   * and the launch screen behind it */
  manifestColors: () => { bar: string; ground: string };
  /** Toyon's own tools for a worktree's agent, over MCP (agent/mcp.ts); the bearer check is its own */
  mcp: (req: Request, worktreeId: string) => Promise<Response>;
}

/** a year, and never revalidate: for a name that cannot mean different bytes later */
const IMMUTABLE = "private, max-age=31536000, immutable";
/** vite content-hashes everything under /assets, so those are immutable by construction. Nothing
 * else the shell serves is: index.html is what maps those hashes to the current build, and a
 * cached one boots an asset graph the daemon no longer has. That lands on the stale-build screen
 * whose reload button reads the same cached index again, with no way out. manifest.json, icon.svg
 * and sw.js are unhashed for the same reason, and a cached worker script is slow to replace. */
const NO_STORE = "no-store";

/** How something a person attached goes back out. One of the image types is drawn as that type and
 * nothing else; everything else is plain text, whatever it is. An uploaded page or SVG must never
 * run on the origin that holds the token, so the type is fixed, sniffing is off, and a browser
 * that navigates there anyway gets a sandboxed document. */
function attachedHeaders(imageType: string | null): Record<string, string> {
  return {
    "content-type": imageType ?? "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...(imageType ? {} : { "content-security-policy": "sandbox" }),
  };
}

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
      managed: opts.managed,
      ...(opts.metrics() as object),
    });

  return async function fetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    // Behind an edge, the platform's health check comes from inside its own network and names the
    // machine's address rather than the public name. /health carries nothing a caller could use.
    if (remote?.front === "edge" && url.pathname === "/health") return health();

    // An agent on this machine calling Toyon's tools. It reaches the daemon by its loopback
    // address in every mode, and behind an edge the door refuses a loopback name as someone
    // guessing, so this route sits in front of it with a guard of its own: a loopback peer, and
    // the per-worktree bearer checked inside.
    if (url.pathname.startsWith("/mcp/")) {
      const peer = srv.requestIP(req)?.address ?? "";
      if (!isLoopbackPeer(peer)) return new Response("forbidden", { status: 403 });
      const worktreeId = url.pathname.slice("/mcp/".length);
      if (!worktreeId || worktreeId.includes("/")) return new Response("not found", { status: 404 });
      return opts.mcp(req, worktreeId);
    }

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
        ...(remoteShell ? { remote: true as const } : {}),
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
    // like /bootstrap. The same page then asks what the restart is waiting on, and those are chat
    // titles, so the answer sits behind the token and not in /health.
    if (url.pathname === "/restart" && (req.method === "POST" || req.method === "GET")) {
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      if (req.method === "GET") return Response.json(opts.restartWait(), { headers: { "cache-control": NO_STORE } });
      const refused = await opts.restart(url.searchParams.has(RESTART_NOW));
      return refused ? new Response(refused, { status: 409 }) : new Response(null, { status: 202 });
    }

    // A pairing code for a phone, asked for by something that already holds the token: the CLI or
    // a shell. Only with a public name, since the link in the code names it and a phone has no
    // other way to this machine.
    if (url.pathname === "/pair" && req.method === "POST") {
      if (!sameSecret(req.headers.get("authorization"), `Bearer ${opts.token}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      if (!remote) {
        return new Response("Set up `toyon remote` first; pairing needs a name a phone can reach.", { status: 400 });
      }
      const { code, ms } = opts.pair.mint();
      const body: PairMint = { code, url: pairLink(remote.host, code), ms };
      return Response.json(body, { headers: { "cache-control": NO_STORE } });
    }

    // Whether a phone could open the link at all, for the card that shows the code. A tailnet name
    // resolves only on a connected device, and a phone that is not one never loads a page of ours.
    if (url.pathname === "/pair/phones" && req.method === "GET") {
      if (!sameSecret(req.headers.get("authorization"), `Bearer ${opts.token}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      const phones = remote && isTailnetName(remote.host) ? await opts.phones() : null;
      return Response.json(phones, { headers: { "cache-control": NO_STORE } });
    }

    // The phone's side: the code for the token, and the preview grant with it as /bootstrap gives
    // one. Only through the front for the public name, where the link in the code points; a page
    // on this machine already has the token and has nothing to pair.
    if (url.pathname === "/pair/redeem" && req.method === "POST") {
      if (!remote || !remoteShell) return new Response("not found", { status: 404 });
      const body = (await req.json().catch(() => ({}))) as { code?: unknown };
      if (typeof body.code !== "string" || !opts.pair.redeem(body.code)) {
        return new Response("code expired", { status: 401 });
      }
      opts.onPaired();
      const reply: PairRedeem = { token: opts.token };
      return Response.json(reply, {
        headers: { "cache-control": NO_STORE, "set-cookie": grantCookie(grant, remote.host) },
      });
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

    // CLI and the Dock icon: open a path, whatever it is. A shell connected now is told at once; one
    // that connects within the next while is told then, since the launcher opens the window after
    // this returns.
    if (url.pathname === "/open" && req.method === "POST") {
      if (!sameSecret(req.headers.get("authorization"), `Bearer ${opts.token}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await req.json().catch(() => ({}))) as { path?: string };
      if (!body.path) return new Response("missing path", { status: 400 });
      try {
        return Response.json(await opts.open(body.path));
      } catch (e) {
        if (e instanceof UserError) return new Response(e.message, { status: 400 });
        log.error("http", "open failed", e);
        return new Response("open failed; see daemon log", { status: 500 });
      }
    }

    // An image or a file, uploaded as its chip appears: the body is the bytes, the type is the
    // header's, and the answer is the id a message names it by. Refused before the body is read
    // when the length already says too much; the store counts what actually arrives.
    if (url.pathname === "/uploads" && req.method === "POST") {
      if (!sameSecret(req.headers.get("authorization"), `Bearer ${opts.token}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      const kind = url.searchParams.get("kind");
      if (!isUploadKind(kind)) return new Response("missing kind", { status: 400 });
      const mime = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      try {
        // a body is read chunk by chunk under Bun, which the DOM's type for it does not say
        const body = req.body as AsyncIterable<Uint8Array> | null;
        return Response.json(await opts.attachments.uploads.put(kind, mime, body), {
          headers: { "cache-control": NO_STORE },
        });
      } catch (e) {
        if (e instanceof UserError) return new Response(e.message, { status: 400 });
        log.error("http", "upload failed", e);
        return new Response("upload failed; see daemon log", { status: 500 });
      }
    }

    // an upload back, for a chip that outlived the page that attached it. An id never means other
    // bytes later, so the browser may keep it.
    if (url.pathname.startsWith("/uploads/")) {
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      const id = url.pathname.slice("/uploads/".length);
      const path = opts.attachments.uploads.path(id);
      if (!path || !existsSync(path)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path), {
        headers: { "cache-control": IMMUTABLE, ...attachedHeaders(opts.attachments.uploads.imageType(id)) },
      });
    }

    // what the shell attached to chat messages (image thumbnails, the text behind a paste or a
    // file chip), back for the transcript. The token rides in the query like /ws does: an
    // <img src> cannot carry a header. Files never change once written, so the browser may keep them.
    if (url.pathname.startsWith("/attachments/")) {
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      const [worktreeId, file, extra] = url.pathname.slice("/attachments/".length).split("/");
      // a removed worktree's chat is shown from the archive, where its images went with it
      const places =
        worktreeId && file && !extra
          ? [opts.attachments.fileFor(worktreeId, file), opts.archivedAttachment(worktreeId, file)]
          : [];
      // a picture a tool returned is named on the chat before its bytes have landed
      if (worktreeId && file) await opts.attachments.whenWritten(worktreeId, file);
      const path = places.find((p): p is string => !!p && existsSync(p));
      if (!path) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path), {
        headers: { "cache-control": IMMUTABLE, ...attachedHeaders(drawnType(file ?? "")) },
      });
    }

    // a file in a worktree the browser draws (an image), for the editor pane's viewer. Token in the
    // query for the same <img> reason. The bytes under a path change as the agent
    // works, so nothing is kept; nosniff holds the type to the extension the service checked.
    if (url.pathname.startsWith("/files/")) {
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      const [worktreeId, ...rest] = url.pathname.slice("/files/".length).split("/");
      let rel = "";
      try {
        rel = rest.map(decodeURIComponent).join("/");
      } catch {
        // a malformed escape names no file: the 404 below
      }
      const path = worktreeId && rel ? await opts.worktreeFile(worktreeId, rel) : null;
      if (!path) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path), {
        headers: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" },
      });
    }

    // a granted file the browser draws (a picture opened from the Dock, the terminal or a link in
    // the chat), by its grant id, served as a worktree's file is
    if (url.pathname.startsWith("/loose/")) {
      if (!sameSecret(url.searchParams.get("token"), opts.token)) return new Response("unauthorized", { status: 401 });
      const path = opts.looseFile(url.pathname.slice("/loose/".length));
      if (!path) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path), {
        headers: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" },
      });
    }

    // static shell
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(opts.shellDist, rel.replaceAll("..", ""));
    const hashed = rel.startsWith("/assets/");
    if (existsSync(file) && Bun.file(file).size > 0) {
      // some browsers colour an installed app's bars from the manifest alone and never read the
      // page's theme-color, so the file on disk is only the shape: the colours are the theme's
      if (rel === "/manifest.json") {
        const { bar, ground } = opts.manifestColors();
        const manifest = { ...(await Bun.file(file).json()), theme_color: bar, background_color: ground };
        return Response.json(manifest, {
          headers: { "content-type": "application/manifest+json", "cache-control": NO_STORE },
        });
      }
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
