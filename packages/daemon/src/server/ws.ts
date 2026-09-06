// WebSocket side of the daemon: socket registry, hello, inbound validation + dispatch, and the
// table of what gets pushed when a hub event fires. Phase 6 scopes the pushes per subscription.

import { PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from "@toyon/shared";
import type { Server, ServerWebSocket } from "bun";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { fireAndForget, log } from "../core/log.ts";
import { lag, type SocketStats } from "../core/metrics.ts";
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

  const raw = (ws: ServerWebSocket<WsData>, json: string) => {
    try {
      ws.send(json);
      ws.data.sent++;
      ws.data.bytes += json.length;
    } catch (e) {
      // a reply to a socket that closed meanwhile (batch finishing late) is not an error
      log.debug("ws", "send to closed socket dropped", e);
    }
  };
  const send = (ws: ServerWebSocket<WsData>, msg: ServerMsg) => raw(ws, JSON.stringify(msg));
  /** every socket: worktree list, proc changes, themes, repos */
  const broadcast = (msg: ServerMsg) => {
    const json = JSON.stringify(msg);
    for (const ws of sockets) raw(ws, json);
  };
  /** only sockets subscribed to the worktree: its agent stream, logs, queue, git status */
  const sendTo = (worktreeId: string, msg: ServerMsg) => {
    let json: string | null = null;
    for (const ws of sockets) {
      if (!ws.data.subs.has(worktreeId)) continue;
      json ??= JSON.stringify(msg);
      raw(ws, json);
    }
  };
  const metrics = () => ({
    lag,
    sockets: [...sockets].map(
      (ws): SocketStats => ({ subs: [...ws.data.subs], sent: ws.data.sent, bytes: ws.data.bytes }),
    ),
  });

  // ---- what a hub event pushes to clients ----
  const worktreesChanged = () =>
    fireAndForget(
      "ws",
      s.worktrees.statuses().then((worktrees) => broadcast({ t: "worktrees", worktrees })),
      "worktrees broadcast",
    );
  s.hub.on("worktreesChanged", worktreesChanged);
  s.hub.on("agentStatus", worktreesChanged);
  s.hub.on("proc", (worktreeId, proc) => broadcast({ t: "proc", worktreeId, proc }));
  s.hub.on("log", (worktreeId, proc, line) => sendTo(worktreeId, { t: "log", worktreeId, proc, line }));
  s.hub.on("queue", (worktreeId, items) => sendTo(worktreeId, { t: "queue", worktreeId, items }));
  // keep the changes list live while the agent edits — coalesced: a turn with ten tool calls in a
  // second runs git status once, not ten times
  const gitStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const refreshGitStatus = (worktreeId: string) => {
    clearTimeout(gitStatusTimers.get(worktreeId));
    gitStatusTimers.set(
      worktreeId,
      setTimeout(async () => {
        gitStatusTimers.delete(worktreeId);
        const wt = s.state.worktree(worktreeId);
        if (!wt) return;
        try {
          sendTo(worktreeId, { t: "git-status", worktreeId, files: await statusFilesWithCounts(wt.path) });
        } catch (e) {
          log.warn(worktreeId, "git status after agent edit failed", e);
        }
      }, 150),
    );
  };
  s.hub.on("agent", (worktreeId, seq, event) => {
    sendTo(worktreeId, { t: "agent", worktreeId, seq, event });
    if (event.type === "tool-end" || event.type === "turn-end") refreshGitStatus(worktreeId);
  });
  s.hub.on("repoTick", (repoId) => {
    // main moved: refresh badges + git status for every subscribed worktree of the repo
    worktreesChanged();
    for (const wt of s.state.worktrees.filter((w) => w.repoId === repoId)) {
      if (![...sockets].some((ws) => ws.data.subs.has(wt.id))) continue;
      fireAndForget(
        wt.id,
        s.worktrees.gitStatus(wt.id).then((msg) => msg && sendTo(wt.id, msg)),
        "git status on ref tick",
      );
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
    fetch: createFetch({ token, shellDist: opts.shellDist, version, repos: s.repos, branded: () => branded, metrics }),
    websocket: {
      async open(ws: ServerWebSocket<WsData>) {
        sockets.add(ws);
        send(ws, {
          t: "hello",
          version,
          protocol: PROTOCOL_VERSION,
          repos: s.state.repos,
          worktrees: await s.worktrees.statuses(),
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
        const ctx = {
          reply: (m: ServerMsg) => send(ws, m),
          broadcast,
          subscribe: (id: string) => ws.data.subs.add(id),
          unsubscribe: (id: string) => ws.data.subs.delete(id),
        };
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
  // best-effort port 80 so the branded http://toyon.localhost works portless (macOS allows
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
