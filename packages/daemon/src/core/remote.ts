// The public name: a shell opened from somewhere other than this machine, through a front that
// terminates TLS. Every front runs the same rules here, for the daemon's own listener and for each
// worktree's preview port alike: the request names the public host, the front says the hop was
// https, and a preview also carries the grant the shell was given. What differs between fronts is
// only where the name comes from and whether the peer check can hold (see `Remote` in shared).

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  checkPreviews,
  isRemoteHost,
  MANAGED_DEFAULTS,
  type ManagedPolicy,
  matchPreview,
  parseRemote,
  portPreviews,
  type Remote,
} from "@toyon/shared";
import { log } from "./log.ts";

/** An edge front is declared by the platform's environment (`toyon deploy fly` writes it); a local
 * one by `remote.json`, which `toyon remote` writes. Edge without a usable name refuses to start:
 * it would otherwise answer on the internet with no Host rule at all. The managed policy governs
 * the local file only: the edge is a machine the person deployed, not the managed laptop. */
export function loadRemote(
  file: string,
  env: Record<string, string | undefined> = process.env,
  managed: Pick<ManagedPolicy, "remote"> = MANAGED_DEFAULTS,
): Remote | null {
  if (env.TOYON_CLOUD === "1") {
    const host = (env.TOYON_PUBLIC_HOST ?? "").toLowerCase();
    if (!isRemoteHost(host)) {
      throw new Error(`TOYON_CLOUD=1 needs TOYON_PUBLIC_HOST, the name the edge answers for; got "${host}"`);
    }
    const previews = env.TOYON_PREVIEWS ?? portPreviews(host);
    const why = checkPreviews(previews, host);
    if (why) throw new Error(`TOYON_PREVIEWS: ${why}`);
    return { host, previews, front: "edge" };
  }
  if (!existsSync(file)) return null;
  if (managed.remote === "off") {
    log.warn("remote", `${file} is ignored: remote access is turned off by your organization's policy`);
    return null;
  }
  const view = parseRemote(readFileSync(file, "utf8"));
  if (!view) {
    log.warn("remote", `${file} names no valid host or previews; remote access is off`);
    return null;
  }
  if (managed.remote === "tailscale" && !view.host.endsWith(".ts.net")) {
    log.warn(
      "remote",
      `${file} names ${view.host}; your organization's policy allows a tailnet name only, so remote access is off`,
    );
    return null;
  }
  return { ...view, front: "local" };
}

/** compare two secrets without leaking where they first differ */
export function sameSecret(given: string | null, want: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const isLoopbackPeer = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
// *.localhost is safe: browsers hardwire it to loopback and public DNS cannot serve it (RFC 6761)
const isLoopbackHost = (h: string) => h === "127.0.0.1" || h === "localhost" || h.endsWith(".localhost");

export type Door =
  | { kind: "refused"; response: Response }
  /** a loopback name from this machine: the local shell, or a preview it frames */
  | { kind: "local" }
  /** the public name itself, on the daemon's listener: the shell */
  | { kind: "shell" }
  /** a preview under the public name: its worktree when routed by name, null on its own port */
  | { kind: "preview"; worktreeId: string | null };

/** The name and port the browser asked for. A front may drop the port from Host and state it in
 * x-forwarded-port instead: Fly's proxy does, on every service port, so a preview at
 * `<app>.fly.dev:10001` arrives as Host `<app>.fly.dev`. The https default port is no port. */
function requestedAuthority(req: Request): string {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (host.includes(":")) return host;
  const port = req.headers.get("x-forwarded-port");
  return port && /^\d{1,5}$/.test(port) && port !== "443" ? `${host}:${port}` : host;
}

const forbidden = (body = "forbidden") => ({ kind: "refused", response: new Response(body, { status: 403 }) }) as const;

/** Who comes in. `listener` is the daemon's own port, or a worktree's preview port. With no public
 * name a preview port answers as it always has: it binds loopback and serves the local shell. */
export function door(req: Request, peer: string, remote: Remote | null, listener: "daemon" | "preview"): Door {
  if (remote === null && listener === "preview") return { kind: "local" };
  // the port-80 listener binds wildcard (macOS allows low ports unprivileged only on 0.0.0.0), and
  // a local front connects from loopback, so the peer check holds everywhere but behind an edge
  if (remote?.front !== "edge" && !isLoopbackPeer(peer)) return forbidden();

  // DNS-rebinding defense: a name is admitted only if it is loopback, or the one public name
  const authority = requestedAuthority(req);
  const host = authority.split(":")[0] ?? "";
  if (isLoopbackHost(host)) {
    // behind an edge nothing is loopback, so a loopback name there is someone guessing
    return remote?.front === "edge" ? forbidden() : { kind: "local" };
  }
  if (remote === null) return forbidden();

  // A preview routed by name comes in on the daemon's listener, one on its own port on that port;
  // the shell is the bare public name on the daemon's. Anything else names nothing toyon serves.
  const preview = matchPreview(remote.previews, authority);
  let worktreeId: string | null = null;
  if (listener === "daemon") {
    if (preview !== null && "id" in preview) worktreeId = preview.id;
    else if (preview !== null || host !== remote.host) return forbidden();
  } else if (preview === null || "id" in preview) {
    return forbidden();
  }
  // A plain-http front would put the token on the network in the clear, and the page would not be
  // a secure context either, so that is refused by name.
  if (req.headers.get("x-forwarded-proto") !== "https") {
    return forbidden(`${host} reaches Toyon over https only; the front must terminate TLS`);
  }
  if (listener === "preview") return { kind: "preview", worktreeId: null };
  return worktreeId === null ? { kind: "shell" } : { kind: "preview", worktreeId };
}

/** the cookie that lets a browser past the gate on a preview under the public name */
export const PREVIEW_COOKIE = "toyon_preview";

/** A preview-only credential, derived so it cannot be turned back into the token: the cookie is
 * sent to every preview, and a preview is the one place code toyon did not write runs. It is
 * stable for as long as the token is, so a grant survives a daemon restart. */
export function previewGrant(token: string): string {
  return createHmac("sha256", token).update("toyon preview grant").digest("hex");
}

/** The Set-Cookie for a shell on `name`: `Domain` reaches every `w<id>.<name>`, and a cookie ignores
 * the port, so it reaches `<name>:<port>` too. Strict, so a link from another site never arrives
 * carrying it: the frames and tabs the shell opens are same-site and still do. */
export function grantCookie(grant: string, name: string): string {
  return `${PREVIEW_COOKIE}=${grant}; Domain=${name}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict`;
}

/** whether the Cookie header carries the grant, and the header with every copy of it removed, so
 * the dev server behind the preview never sees it. Null `rest` when nothing else was sent. */
export function takeGrant(cookie: string | null, grant: string): { ok: boolean; rest: string | null } {
  let ok = false;
  const kept: string[] = [];
  for (const part of (cookie ?? "").split(";")) {
    const pair = part.trim();
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === PREVIEW_COOKIE) {
      if (sameSecret(pair.slice(eq + 1), grant)) ok = true;
      continue;
    }
    kept.push(pair);
  }
  return { ok, rest: kept.length ? kept.join("; ") : null };
}

/** The gate on a preview: the request as the app should see it, or the refusal. Checked before
 * anything says whether the worktree exists. The page reloads itself, so a frame that painted
 * before the shell's bootstrap set the cookie recovers without anyone touching it. */
export function passPreview(
  req: Request,
  grant: string,
): { ok: true; req: Request } | { ok: false; response: Response } {
  const pass = takeGrant(req.headers.get("cookie"), grant);
  if (!pass.ok) {
    return {
      ok: false,
      response: new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"></head>` +
          `<body>This preview opens from Toyon; open your Toyon link first.</body></html>`,
        { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
      ),
    };
  }
  const headers = new Headers(req.headers);
  if (pass.rest === null) headers.delete("cookie");
  else headers.set("cookie", pass.rest);
  return { ok: true, req: new Request(req, { headers }) };
}

/** whether a Set-Cookie line sets the grant: an app on the same name could otherwise overwrite it
 * and lock the browser out of every preview */
export function setsGrant(line: string): boolean {
  return line.slice(0, line.indexOf("=")).trim() === PREVIEW_COOKIE;
}
