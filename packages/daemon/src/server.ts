import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClientMsg, ServerMsg } from "@orchardist/shared";
import type { Manager } from "./worktrees.ts";
import { fileBefore, statusFiles } from "./git.ts";

const VERSION = "0.0.1";

interface WsData {
  authed: boolean;
}

export function startServer(opts: {
  port: number;
  token: string;
  manager: Manager;
  shellDist: string;
}) {
  const { manager, token } = opts;
  const sockets = new Set<import("bun").ServerWebSocket<WsData>>();

  const broadcast = (msg: ServerMsg) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) ws.send(s);
  };

  const hub = {
    broadcast,
    worktreesChanged: () => broadcast({ t: "worktrees", worktrees: manager.statuses() }),
  };

  const server = Bun.serve<WsData, string>({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);

      // DNS-rebinding defense: only accept loopback Host headers
      const host = (req.headers.get("host") ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") {
        return new Response("forbidden", { status: 403 });
      }

      if (url.pathname === "/ws") {
        if (url.searchParams.get("token") !== token) {
          return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req, { data: { authed: true } })) {
          return undefined as unknown as Response;
        }
        return new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname === "/health") {
        return Response.json({ ok: true, version: VERSION });
      }

      // CLI: register a repo with the running daemon
      if (url.pathname === "/register" && req.method === "POST") {
        if (req.headers.get("authorization") !== `Bearer ${token}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const body = (await req.json()) as { path?: string };
        if (!body.path) return new Response("missing path", { status: 400 });
        const repo = await manager.registerRepo(body.path);
        return Response.json({ repoId: repo.id });
      }

      // static shell
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(opts.shellDist, rel.replaceAll("..", ""));
      if (existsSync(file) && Bun.file(file).size > 0) {
        return new Response(Bun.file(file));
      }
      const index = join(opts.shellDist, "index.html");
      if (existsSync(index)) return new Response(Bun.file(index));
      return new Response(
        "orchardist daemon running; shell not built (run: bun run build)",
        { status: 200 },
      );
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const hello: ServerMsg = {
          t: "hello",
          version: VERSION,
          repos: manager.state.repos,
          worktrees: manager.statuses(),
        };
        ws.send(JSON.stringify(hello));
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        let msg: ClientMsg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        try {
          await handle(msg, ws);
        } catch (e) {
          ws.send(JSON.stringify({ t: "error", message: String(e) } satisfies ServerMsg));
        }
      },
    },
  });

  async function handle(msg: ClientMsg, ws: import("bun").ServerWebSocket<WsData>) {
    switch (msg.t) {
      case "subscribe": {
        const agent = manager.agentFor(msg.worktreeId);
        const events = agent?.transcript() ?? [];
        const backfill: ServerMsg = {
          t: "backfill",
          worktreeId: msg.worktreeId,
          events: events.slice(-1000),
        };
        ws.send(JSON.stringify(backfill));
        sendGitStatus(msg.worktreeId, ws);
        break;
      }
      case "chat": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        let agent = manager.agentFor(msg.worktreeId);
        if (!agent) throw new Error("worktree still starting; try again in a moment");
        agent.send(msg.text);
        break;
      }
      case "create-worktree": {
        await manager.createWorktree(msg.repoId, msg.prompt);
        break;
      }
      case "remove-worktree": {
        await manager.removeWorktree(msg.worktreeId);
        break;
      }
      case "restart-proc": {
        manager.runtime(msg.worktreeId)?.procs.restart(msg.proc);
        break;
      }
      case "git-status": {
        sendGitStatus(msg.worktreeId, ws);
        break;
      }
      case "file-diff": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) return;
        const repo = manager.repo(wt.repoId);
        const before = fileBefore(wt.path, repo.defaultBranch, msg.path);
        const afterFile = Bun.file(join(wt.path, msg.path));
        const after = (await afterFile.exists()) ? await afterFile.text() : "";
        const out: ServerMsg = { t: "file-diff", worktreeId: msg.worktreeId, path: msg.path, before, after };
        ws.send(JSON.stringify(out));
        break;
      }
      case "confirm-config": {
        manager.confirmConfig(msg.repoId, msg.config);
        break;
      }
    }
  }

  function sendGitStatus(worktreeId: string, ws: import("bun").ServerWebSocket<WsData>) {
    const wt = manager.worktree(worktreeId);
    if (!wt) return;
    try {
      const files = statusFiles(wt.path);
      ws.send(JSON.stringify({ t: "git-status", worktreeId, files } satisfies ServerMsg));
    } catch {
      // worktree may still be setting up
    }
  }

  return { server, hub };
}
