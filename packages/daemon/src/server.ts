import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClientMsg, ServerMsg } from "@orchardist/shared";
import type { Manager } from "./worktrees.ts";
import { aheadBehind, changedRanges, commitWorktree, committedFiles, fileBefore, mergeToMain, shipWorktree, statusFiles, syncFromMain } from "./git.ts";
import { cloud } from "./cloud.ts";

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

  const serverConfig = {
    hostname: cloud.bindHost,
    async fetch(req: Request, srv: import("bun").Server<WsData>) {
      const url = new URL(req.url);

      // Cloud mode sits behind the host's TLS edge: peers and Host headers are
      // remote by design, and the bearer token on /ws and /register is the auth.
      if (!cloud.enabled) {
        // the port-80 listener binds wildcard (macOS allows low ports unprivileged
        // only on 0.0.0.0) — so enforce loopback peers on every request
        const ip = srv.requestIP(req)?.address ?? "";
        if (ip !== "127.0.0.1" && ip !== "::1" && !ip.startsWith("::ffff:127.")) {
          return new Response("forbidden", { status: 403 });
        }

        // DNS-rebinding defense: loopback hosts only. *.localhost is safe —
        // browsers hardwire it to loopback and public DNS cannot serve it (RFC 6761).
        const host = (req.headers.get("host") ?? "").split(":")[0] ?? "";
        if (host !== "127.0.0.1" && host !== "localhost" && !host.endsWith(".localhost")) {
          return new Response("forbidden", { status: 403 });
        }
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
        return Response.json({ ok: true, version: VERSION, branded });
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
      open(ws: import("bun").ServerWebSocket<WsData>) {
        sockets.add(ws);
        const hello: ServerMsg = {
          t: "hello",
          version: VERSION,
          repos: manager.state.repos,
          worktrees: manager.statuses(),
        };
        ws.send(JSON.stringify(hello));
      },
      close(ws: import("bun").ServerWebSocket<WsData>) {
        sockets.delete(ws);
      },
      async message(ws: import("bun").ServerWebSocket<WsData>, raw: string | Buffer) {
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
  };

  const server = Bun.serve<WsData, string>({ ...serverConfig, port: opts.port });
  // best-effort port 80 so the branded http://orchardist.localhost works portless
  // (macOS allows unprivileged low-port binds; failure is fine, :4141 remains)
  let branded = false;
  if (opts.port !== 80 && !cloud.enabled) {
    try {
      // wildcard bind is required for unprivileged :80 on macOS; the loopback
      // peer check in fetch() keeps it effectively local-only
      Bun.serve<WsData, string>({ ...serverConfig, hostname: "0.0.0.0", port: 80 });
      branded = true;
    } catch {}
  }

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
        ws.send(JSON.stringify({
          t: "queue", worktreeId: msg.worktreeId, items: agent?.queueItems ?? [],
        } satisfies ServerMsg));
        sendGitStatus(msg.worktreeId, ws);
        break;
      }
      case "chat": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        let agent = manager.agentFor(msg.worktreeId);
        if (!agent) throw new Error("worktree still starting; try again in a moment");
        agent.send(msg.text, msg.context, msg.pick);
        hub.worktreesChanged(); // queued-count may have changed
        break;
      }
      case "create-worktree": {
        await manager.createWorktree(msg.repoId, msg.prompt, msg.baseWorktreeId, msg.variant, msg.context, msg.pick);
        break;
      }
      case "batch-worktrees": {
        const repo = manager.repo(msg.repoId);
        ws.send(JSON.stringify({
          t: "shipped", worktreeId: "", ok: true, message: "batch: planning tasks…",
        } satisfies ServerMsg));
        // plan + spawn in the background so the socket stays responsive
        void (async () => {
          const { planTasks } = await import("./agent.ts");
          const tasks = (await planTasks(msg.prompt, repo.path)) ?? [msg.prompt];
          for (const task of tasks) {
            try {
              await manager.createWorktree(msg.repoId, task);
            } catch {}
          }
          ws.send(JSON.stringify({
            t: "shipped", worktreeId: "", ok: true,
            message: `batch: ${tasks.length} worktree(s) started`,
          } satisfies ServerMsg));
        })();
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
      case "ship": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        if (wt.kind === "main") throw new Error("ship from a worktree, not main");
        const repo = manager.repo(wt.repoId);
        const result = shipWorktree(wt.path, wt.branch, repo.defaultBranch, wt.title);
        if (result.prCreated && result.url) manager.setPrUrl(wt.id, result.url);
        ws.send(JSON.stringify({
          t: "shipped", worktreeId: wt.id, ok: result.ok, url: result.url, message: result.message,
        } satisfies ServerMsg));
        sendGitStatus(wt.id, ws);
        break;
      }
      case "merge-main": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        if (wt.kind === "main") throw new Error("merge from a worktree, not main");
        const repo = manager.repo(wt.repoId);
        const result = mergeToMain(wt.path, wt.branch, repo.path, repo.defaultBranch, wt.title);
        if (result.ok) manager.setLanded(wt.id, true);
        // landing a graft lands its sources; landing a variant ends the tournament —
        // in both cases offer to clean up the whole family
        let removeIds: string[] | undefined;
        if (result.ok && wt.kind === "combined") {
          removeIds = [wt.id, ...(wt.sources ?? []).filter((id) => manager.worktree(id))];
        } else if (result.ok && wt.variant) {
          removeIds = manager.state.worktrees
            .filter((w) => w.variant?.group === wt.variant!.group)
            .map((w) => w.id);
        } else if (result.ok) {
          removeIds = [wt.id];
        }
        ws.send(JSON.stringify({
          t: "shipped", worktreeId: wt.id, ok: result.ok, message: result.message, merged: result.ok, removeIds,
        } satisfies ServerMsg));
        sendGitStatus(wt.id, ws);
        break;
      }
      case "sync-main": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        if (wt.kind === "main") throw new Error("main doesn't sync with itself");
        const repo = manager.repo(wt.repoId);
        const result = syncFromMain(wt.path, repo.defaultBranch);
        const suggestion = result.ok
          ? undefined
          : `Merge ${repo.defaultBranch} into this branch and resolve the conflicts, then verify the app still works.`;
        ws.send(JSON.stringify({
          t: "shipped", worktreeId: wt.id, ok: result.ok,
          message: result.ok ? result.message : `sync conflicts with ${repo.defaultBranch} — prompt prefilled in chat`,
          suggestion,
        } satisfies ServerMsg));
        sendGitStatus(wt.id, ws);
        break;
      }
      case "commit": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        const message = msg.message.trim();
        if (!message) throw new Error("commit message required");
        const result = commitWorktree(wt.path, message);
        ws.send(JSON.stringify({
          t: "shipped", worktreeId: wt.id, ok: result.ok, message: result.message,
        } satisfies ServerMsg));
        sendGitStatus(wt.id, ws);
        break;
      }
      case "combine": {
        const wt = await manager.combineWorktrees(msg.worktreeIds);
        ws.send(JSON.stringify({
          t: "shipped", worktreeId: wt.id, ok: true,
          message: `grafted: ${wt.title} — local merge of ${msg.worktreeIds.length} branches, nothing pushed`,
        } satisfies ServerMsg));
        break;
      }
      case "rename-worktree": {
        await manager.renameWorktree(msg.worktreeId, msg.title);
        break;
      }
      case "list-files": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        // tracked + untracked (respecting .gitignore)
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
          cwd: wt.path, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        });
        const paths = (r.stdout ?? "").split("\n").filter(Boolean);
        ws.send(JSON.stringify({ t: "files", worktreeId: wt.id, paths } satisfies ServerMsg));
        break;
      }
      case "stop-agent": {
        manager.agentFor(msg.worktreeId)?.stop();
        break;
      }
      case "pick-variant": {
        await manager.pickVariant(msg.worktreeId);
        break;
      }
      case "unqueue": {
        manager.agentFor(msg.worktreeId)?.unqueue(msg.index);
        break;
      }
      case "changed-ranges": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) return;
        const repo = manager.repo(wt.repoId);
        const ranges = changedRanges(wt.path, repo.defaultBranch, msg.path);
        const lineOffset = await manager.lineOffset(wt.id, msg.path);
        ws.send(JSON.stringify({
          t: "changed-ranges", worktreeId: wt.id, path: msg.path, ranges, lineOffset,
        } satisfies ServerMsg));
        break;
      }
      case "reveal": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        const { resolve } = await import("node:path");
        const target = resolve(wt.path, msg.path ?? ".");
        if (target !== resolve(wt.path) && !target.startsWith(resolve(wt.path) + "/")) {
          throw new Error("path escapes worktree");
        }
        // Finder reveal is macOS-only; elsewhere there is no viewer-side filesystem.
        // An unhandled spawn 'error' (missing `open`) would take the daemon down.
        if (process.platform !== "darwin") throw new Error("reveal is only available on macOS");
        const { spawn } = await import("node:child_process");
        const child = spawn("open", ["-R", target], { stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
        break;
      }
      case "discard-file": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        const entry = statusFiles(wt.path).find((f) => f.path === msg.path);
        if (!entry) throw new Error("file has no uncommitted changes");
        if (entry.xy === "??") {
          const { resolve } = await import("node:path");
          const target = resolve(wt.path, msg.path);
          if (!target.startsWith(resolve(wt.path) + "/")) throw new Error("path escapes worktree");
          const { unlinkSync } = await import("node:fs");
          unlinkSync(target);
        } else {
          const { spawnSync } = await import("node:child_process");
          spawnSync("git", ["checkout", "HEAD", "--", msg.path], { cwd: wt.path });
        }
        ws.send(JSON.stringify({ t: "shipped", worktreeId: wt.id, ok: true, message: `discarded ${msg.path}` } satisfies ServerMsg));
        sendGitStatus(wt.id, ws);
        break;
      }
      case "write-file": {
        const wt = manager.worktree(msg.worktreeId);
        if (!wt) throw new Error("unknown worktree");
        const { resolve } = await import("node:path");
        const target = resolve(wt.path, msg.path);
        if (!target.startsWith(resolve(wt.path) + "/")) throw new Error("path escapes worktree");
        await Bun.write(target, msg.content);
        // no toast: autosave fires constantly; the changes list is the feedback
        sendGitStatus(wt.id, ws);
        break;
      }
      case "confirm-config": {
        manager.confirmConfig(msg.repoId, msg.config);
        break;
      }
    }
  }

  function sendGitStatus(worktreeId: string, ws: import("bun").ServerWebSocket<WsData>) {
    const msg = manager.gitStatusMsg(worktreeId);
    if (msg) ws.send(JSON.stringify(msg));
  }

  return { server, hub, branded };
}
