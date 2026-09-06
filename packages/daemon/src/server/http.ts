// HTTP side of the daemon: loopback/host guards, /ws auth + upgrade, /health, /register (CLI),
// and the static shell. Business logic stays in the services it calls.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { cloud } from "../core/cloud.ts";
import type { RepoRegistry } from "../repos/registry.ts";

export interface WsData {
  authed: boolean;
}

export interface HttpOpts {
  token: string;
  shellDist: string;
  version: string;
  repos: RepoRegistry;
  /** whether the portless http://orchardist.localhost listener came up (known after bind) */
  branded: () => boolean;
}

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
      if (url.searchParams.get("token") !== opts.token) return new Response("unauthorized", { status: 401 });
      if (srv.upgrade(req, { data: { authed: true } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: opts.version, branded: opts.branded() });
    }

    // CLI: register a repo with the running daemon
    if (url.pathname === "/register" && req.method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${opts.token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await req.json()) as { path?: string };
      if (!body.path) return new Response("missing path", { status: 400 });
      const repo = await opts.repos.register(body.path);
      return Response.json({ repoId: repo.id });
    }

    // static shell
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(opts.shellDist, rel.replaceAll("..", ""));
    if (existsSync(file) && Bun.file(file).size > 0) return new Response(Bun.file(file));
    const index = join(opts.shellDist, "index.html");
    if (existsSync(index)) return new Response(Bun.file(index));
    return new Response("orchardist daemon running; shell not built (run: bun run build)", { status: 200 });
  };
}
