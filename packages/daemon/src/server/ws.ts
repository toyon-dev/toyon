// WebSocket side of the daemon: socket registry, hello, inbound validation + dispatch, and the
// table of what gets pushed when a hub event fires. Phase 6 scopes the pushes per subscription.

import { PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from "@orchardist/shared";
import type { Server, ServerWebSocket } from "bun";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { statusFilesWithCounts } from "../git/status.ts";
import { setWaitingColors } from "../runtime/proxy.ts";
import { dispatch, type Services } from "./handlers.ts";
import { createFetch, type WsData } from "./http.ts";

export interface ServerOpts {
  port: number;
  token: string;
  shellDist: string;
  version: string;
  services: Services;
}

export function startServer(opts: ServerOpts): { server: Server<WsData>; branded: boolean; stop: () => void } {
  const { services: s, token, version } = opts;
  const sockets = new Set<ServerWebSocket<WsData>>();

  const send = (ws: ServerWebSocket<WsData>, msg: ServerMsg) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      // a reply to a socket that closed meanwhile (batch finishing late) is not an error
      log.debug("ws", "send to closed socket dropped", e);
    }
  };
  const broadcast = (msg: ServerMsg) => {
    const raw = JSON.stringify(msg);
    for (const ws of sockets) ws.send(raw);
  };

  // ---- what a hub event pushes to clients ----
  const worktreesChanged = () => broadcast({ t: "worktrees", worktrees: s.worktrees.statuses() });
  s.hub.on("worktreesChanged", worktreesChanged);
  s.hub.on("agentStatus", worktreesChanged);
  s.hub.on("proc", (worktreeId, proc) => broadcast({ t: "proc", worktreeId, proc }));
  s.hub.on("log", (worktreeId, proc, line) => broadcast({ t: "log", worktreeId, proc, line }));
  s.hub.on("queue", (worktreeId, items) => broadcast({ t: "queue", worktreeId, items }));
  s.hub.on("agent", (worktreeId, seq, event) => {
    broadcast({ t: "agent", worktreeId, seq, event });
    // keep the changes list live while the agent edits
    if (event.type === "tool-end" || event.type === "turn-end") {
      const wt = s.state.worktree(worktreeId);
      if (!wt) return;
      try {
        broadcast({ t: "git-status", worktreeId, files: statusFilesWithCounts(wt.path) });
      } catch (e) {
        log.warn(worktreeId, "git status after agent edit failed", e);
      }
    }
  });
  s.hub.on("repoTick", (repoId) => {
    // main moved: refresh badges + git status for every worktree of the repo
    worktreesChanged();
    for (const wt of s.state.worktrees.filter((w) => w.repoId === repoId)) {
      const msg = s.worktrees.gitStatus(wt.id);
      if (msg) broadcast(msg);
    }
  });
  const themesChanged = () => {
    const cur = s.themes.current();
    setWaitingColors({ bg: cur.colors.bg0, fg: cur.colors.fgMuted });
    broadcast({ t: "themes", themes: s.themes.themes, prefs: s.themes.prefs });
  };
  s.hub.on("themesChanged", themesChanged);
  themesChanged();

  let branded = false;
  const serverConfig = {
    hostname: cloud.bindHost,
    fetch: createFetch({ token, shellDist: opts.shellDist, version, repos: s.repos, branded: () => branded }),
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        sockets.add(ws);
        send(ws, {
          t: "hello",
          version,
          protocol: PROTOCOL_VERSION,
          repos: s.state.repos,
          worktrees: s.worktrees.statuses(),
          themes: s.themes.themes,
          themePrefs: s.themes.prefs,
        });
      },
      close(ws: ServerWebSocket<WsData>) {
        sockets.delete(ws);
      },
      async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        let json: unknown;
        try {
          json = JSON.parse(String(raw));
        } catch {
          send(ws, { t: "error", message: "invalid message: not JSON" });
          return;
        }
        const parsed = parseClientMsg(json);
        if (!parsed.ok) {
          send(ws, { t: "error", message: `invalid message: ${parsed.reason}` });
          return;
        }
        const ctx = { reply: (m: ServerMsg) => send(ws, m), broadcast };
        try {
          await dispatch(parsed.msg, ctx, s);
        } catch (e) {
          if (!(e instanceof UserError)) log.error("ws", `${parsed.msg.t} failed`, e);
          send(ws, { t: "error", message: e instanceof Error ? e.message : String(e) });
        }
      },
    },
  };

  const server = Bun.serve<WsData, string>({ ...serverConfig, port: opts.port });
  // best-effort port 80 so the branded http://orchardist.localhost works portless (macOS allows
  // unprivileged low-port binds; failure is fine, :4141 remains)
  let brandedServer: Server<WsData> | null = null;
  if (opts.port !== 80 && !cloud.enabled) {
    try {
      // wildcard bind is required for unprivileged :80 on macOS; the loopback peer check in
      // fetch() keeps it effectively local-only
      brandedServer = Bun.serve<WsData, string>({ ...serverConfig, hostname: "0.0.0.0", port: 80 });
      branded = true;
    } catch {}
  }

  return {
    server,
    branded,
    stop: () => {
      server.stop(true);
      brandedServer?.stop(true);
    },
  };
}
