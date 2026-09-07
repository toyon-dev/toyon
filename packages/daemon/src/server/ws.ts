// WebSocket side of the daemon: socket registry, hello, inbound validation + dispatch, and the
// table of what gets pushed when a hub event fires. Phase 6 scopes the pushes per subscription.

import { PROTOCOL_VERSION, parseClientMsg, type ServerMsg, ThemeImportError } from "@toyon/shared";
import type { Server, ServerWebSocket } from "bun";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { fireAndForget, log } from "../core/log.ts";
import { lag, type SocketStats } from "../core/metrics.ts";
import { setWaitingColors } from "../runtime/proxy.ts";
import { DEFAULT_AGENT_ID } from "../runtime/registry.ts";
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
  const sendWhere = (worktreeId: string, msg: ServerMsg, set: (d: WsData) => Set<string>) => {
    let json: string | null = null;
    for (const ws of sockets) {
      if (!set(ws.data).has(worktreeId)) continue;
      json ??= JSON.stringify(msg);
      raw(ws, json);
    }
  };
  /** only sockets subscribed to the worktree: its agent stream, logs, queue, git status */
  const sendTo = (worktreeId: string, msg: ServerMsg) => sendWhere(worktreeId, msg, (d) => d.subs);
  /** only sockets with the worktree's terminal pane open: a background shell streams nowhere */
  const sendTerm = (worktreeId: string, msg: ServerMsg) => sendWhere(worktreeId, msg, (d) => d.terms);
  const metrics = () => ({
    lag,
    sockets: [...sockets].map(
      (ws): SocketStats => ({ subs: [...ws.data.subs], sent: ws.data.sent, bytes: ws.data.bytes }),
    ),
  });

  // ---- what a hub event pushes to clients ----
  // single-flight: a burst of changes (five creates, ten proc events) yields one statuses() run
  // in flight and at most one more after it, and snapshots can never land out of order
  let statusesInFlight = false;
  let statusesDirty = false;
  const worktreesChanged = () => {
    if (statusesInFlight) {
      statusesDirty = true;
      return;
    }
    statusesInFlight = true;
    fireAndForget(
      "ws",
      (async () => {
        do {
          statusesDirty = false;
          broadcast({ t: "worktrees", worktrees: await s.worktrees.statuses() });
        } while (statusesDirty);
      })().finally(() => {
        statusesInFlight = false;
      }),
      "worktrees broadcast",
    );
  };
  s.hub.on("worktreesChanged", worktreesChanged);
  s.hub.on("agentStatus", worktreesChanged);
  s.hub.on("reposChanged", () => broadcast({ t: "repos", repos: s.state.repos }));
  s.hub.on("proc", (worktreeId, proc) => broadcast({ t: "proc", worktreeId, proc }));
  s.hub.on("log", (worktreeId, proc, line) => sendTo(worktreeId, { t: "log", worktreeId, proc, line }));
  s.hub.on("queue", (worktreeId, items) => sendTo(worktreeId, { t: "queue", worktreeId, items }));
  s.hub.on("termData", (worktreeId, data) => sendTerm(worktreeId, { t: "term-data", worktreeId, data }));
  s.hub.on("termExit", (worktreeId, exitCode) => sendTerm(worktreeId, { t: "term-exit", worktreeId, exitCode }));
  // keep the changes list live while the agent edits — coalesced: a turn with ten tool calls in a
  // second runs git status once, not ten times
  const gitStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const refreshGitStatus = (worktreeId: string) => {
    clearTimeout(gitStatusTimers.get(worktreeId));
    gitStatusTimers.set(
      worktreeId,
      setTimeout(() => {
        gitStatusTimers.delete(worktreeId);
        // the same producer as subscribe/edits, so ahead/behind/committed are never blanked
        fireAndForget(worktreeId, pushGitStatus(worktreeId), "git status after agent edit");
      }, 150),
    );
  };
  s.hub.on("agent", (worktreeId, seq, event) => {
    sendTo(worktreeId, { t: "agent", worktreeId, seq, event });
    if (event.type === "tool-end" || event.type === "turn-end") refreshGitStatus(worktreeId);
  });
  const pushGitStatus = async (worktreeId: string) => {
    if (![...sockets].some((ws) => ws.data.subs.has(worktreeId))) return;
    const info = await s.worktrees.gitStatus(worktreeId);
    if (info) sendTo(worktreeId, { t: "git-status", worktreeId, ...info });
  };
  s.hub.on("repoTick", (repoId) => {
    // main moved: refresh badges + git status for every subscribed worktree of the repo
    worktreesChanged();
    for (const wt of s.state.worktrees.filter((w) => w.repoId === repoId)) {
      fireAndForget(wt.id, pushGitStatus(wt.id), "git status on ref tick");
    }
  });
  const themesChanged = () => {
    const cur = s.themes.current();
    setWaitingColors({ bg: cur.colors.bg0, fg: cur.colors.fgMuted });
    broadcast({ t: "themes", themes: s.themes.themes, prefs: s.themes.prefs });
  };
  s.hub.on("themesChanged", themesChanged);
  themesChanged();
  // the registry knows what is installed, accounts knows who each one is logged in as
  const agentInfos = () => s.accounts.describe(s.agents.infos());
  const agentsMsg = () =>
    ({
      t: "agents",
      agents: agentInfos(),
      defaultAgent: s.state.defaultAgent ?? DEFAULT_AGENT_ID,
    }) satisfies ServerMsg;
  s.hub.on("agentsChanged", () => broadcast(agentsMsg()));

  let branded = false;
  const serverConfig = {
    hostname: cloud.bindHost,
    fetch: createFetch({
      token,
      shellDist: opts.shellDist,
      version,
      repos: s.repos,
      attachments: s.attachments,
      branded: () => branded,
      metrics,
    }),
    websocket: {
      // a chat frame can carry IMAGES_PER_MESSAGE images of IMAGE_MAX_BYTES each, base64; Bun's
      // default (16 MB) would drop the socket mid-paste
      maxPayloadLength: 64 * 1024 * 1024,
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
          agents: agentInfos(),
          defaultAgent: s.state.defaultAgent ?? DEFAULT_AGENT_ID,
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
          subscribe: (id: string) => {
            if (ws.data.subs.has(id)) return false;
            ws.data.subs.add(id);
            return true;
          },
          unsubscribe: (id: string) => {
            ws.data.subs.delete(id);
          },
          watchTerminal: (id: string) => {
            ws.data.terms.add(id);
          },
          unwatchTerminal: (id: string) => {
            ws.data.terms.delete(id);
          },
        };
        try {
          await dispatch(parsed.msg, ctx, s);
        } catch (e) {
          // theme import errors are the user's file, not our bug
          if (!(e instanceof UserError || e instanceof ThemeImportError)) log.error("ws", `${parsed.msg.t} failed`, e);
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
