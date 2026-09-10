// WebSocket side of the daemon: socket registry, hello, inbound validation + dispatch, and the
// table of what gets pushed when a hub event fires.

import { homedir } from "node:os";
import {
  PROTOCOL_VERSION,
  parseClientMsg,
  type ServerMsg,
  streamKey,
  ThemeImportError,
  WS_CLOSE_UNAUTHORIZED,
} from "@toyon/shared";
import type { Server, ServerWebSocket } from "bun";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { fireAndForget, log } from "../core/log.ts";
import { lag, type SocketStats } from "../core/metrics.ts";
import { setWaitingColors } from "../runtime/proxy.ts";
import { DEFAULT_AGENT_ID } from "../runtime/registry.ts";
import { dispatch, type Services } from "./handlers.ts";
import { createFetch, type WsData } from "./http.ts";

/** how far behind a socket may fall before its terminal output is dropped instead of queued */
const DROP_ABOVE_BYTES = 4 * 1024 * 1024;
const DROPPED_NOTICE = "\r\n[toyon] output dropped: this pane was too far behind\r\n";

interface TermChunk {
  worktreeId: string;
  stream: string;
  data: string;
}

export interface ServerOpts {
  port: number;
  token: string;
  shellDist: string;
  version: string;
  services: Services;
  /** where a shell authenticated from, passed on to the bridge script (see BridgeScript) */
  noteShellOrigin: (origin: string | null) => void;
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
  /** only sockets with that exact tab open: a stream nobody is looking at streams nowhere */
  const sendTerm = (worktreeId: string, stream: string, msg: ServerMsg) => {
    const key = streamKey(worktreeId, stream);
    let json: string | null = null;
    for (const ws of sockets) {
      if (!ws.data.terms.has(key)) continue;
      json ??= JSON.stringify(msg);
      raw(ws, json);
    }
  };

  // term-data is the only high-rate frame, and Hub.emit is synchronous, so a pty read loop runs
  // the whole fan-out inline. Coalesce a tick's worth per socket per stream into one frame, and
  // when a socket is already behind, drop what piled up rather than queueing it forever.
  const pending = new Map<ServerWebSocket<WsData>, Map<string, TermChunk>>();
  let flushQueued = false;
  const queueTerm = (worktreeId: string, stream: string, data: string) => {
    const key = streamKey(worktreeId, stream);
    for (const ws of sockets) {
      if (!ws.data.terms.has(key)) continue;
      let perSocket = pending.get(ws);
      if (!perSocket) {
        perSocket = new Map();
        pending.set(ws, perSocket);
      }
      const chunk = perSocket.get(key);
      if (chunk) chunk.data += data;
      else perSocket.set(key, { worktreeId, stream, data });
    }
    if (pending.size > 0 && !flushQueued) {
      flushQueued = true;
      setImmediate(flushTerm);
    }
  };
  const flushTerm = () => {
    flushQueued = false;
    for (const [ws, perSocket] of pending) {
      const behind = ws.getBufferedAmount() > DROP_ABOVE_BYTES;
      for (const [key, chunk] of perSocket) {
        if (behind) {
          // one notice per stream until it catches up, else the notice becomes the flood
          if (!ws.data.dropped.has(key)) {
            ws.data.dropped.add(key);
            send(ws, { t: "term-data", worktreeId: chunk.worktreeId, stream: chunk.stream, data: DROPPED_NOTICE });
          }
          continue;
        }
        ws.data.dropped.delete(key);
        send(ws, { t: "term-data", worktreeId: chunk.worktreeId, stream: chunk.stream, data: chunk.data });
      }
    }
    pending.clear();
  };
  const metrics = () => ({
    lag,
    // what the daemon is running, for `toyon doctor`: worktrees start when opened, not at boot
    worktrees: {
      total: s.state.worktrees.filter((w) => w.kind !== "spare").length,
      running: s.runtime.runningCount(),
    },
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
          broadcast({ t: "worktrees", rows: await s.worktrees.rows() });
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
  s.hub.on("pendingChanged", () => broadcast({ t: "pending-repos", pending: s.repos.pending }));
  s.hub.on("proc", (worktreeId, proc) => broadcast({ t: "proc", worktreeId, proc }));
  s.hub.on("log", (worktreeId, proc, line) => sendTo(worktreeId, { t: "log", worktreeId, proc, line }));
  s.hub.on("queue", (worktreeId, items) => sendTo(worktreeId, { t: "queue", worktreeId, items }));
  s.hub.on("agentCommands", (worktreeId, commands) =>
    sendTo(worktreeId, { t: "agent-commands", worktreeId, commands }),
  );
  s.hub.on("termData", (worktreeId, stream, data) => queueTerm(worktreeId, stream, data));
  s.hub.on("termExit", (worktreeId, stream, exitCode) =>
    sendTerm(worktreeId, stream, { t: "term-exit", worktreeId, stream, exitCode }),
  );
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
    // main moved: refresh badges + git status for every subscribed worktree of the repo,
    // discovered ones included, since their behind count moved with it
    worktreesChanged();
    const subscribed = new Set<string>();
    for (const ws of sockets) for (const id of ws.data.subs) subscribed.add(id);
    for (const id of subscribed) {
      if (s.worktrees.readable(id)?.repoId !== repoId) continue;
      fireAndForget(id, pushGitStatus(id), "git status on ref tick");
    }
  });
  const themesChanged = () => {
    const cur = s.themes.current();
    setWaitingColors({ bg: cur.colors.surface0, fg: cur.colors.text1 });
    broadcast({ t: "themes", themes: s.themes.themes, prefs: s.themes.prefs });
  };
  s.hub.on("themesChanged", themesChanged);
  themesChanged();
  // the registry knows what is installed, accounts knows who each one is logged in as
  const agentInfos = () =>
    s.accounts.describe(s.agents.infos()).map((a) => {
      const models = s.state.cachedModels(a.id);
      return models.length > 0 ? { ...a, models } : a;
    });
  const agentsMsg = () =>
    ({
      t: "agents",
      agents: agentInfos(),
      defaultAgent: s.state.defaultAgent ?? DEFAULT_AGENT_ID,
    }) satisfies ServerMsg;
  s.hub.on("agentsChanged", () => broadcast(agentsMsg()));

  // What a page learns first, over the socket or over the bootstrap fetch that precedes it. Quick
  // rows: the frame goes out from what is known and the counts follow, rather than every page
  // load waiting on a git pass across every worktree.
  const helloFrame = async () =>
    ({
      t: "hello",
      version,
      protocol: PROTOCOL_VERSION,
      repos: s.state.repos,
      rows: await s.worktrees.rows({ quick: true }),
      themes: s.themes.themes,
      themePrefs: s.themes.prefs,
      agents: agentInfos(),
      defaultAgent: s.state.defaultAgent ?? DEFAULT_AGENT_ID,
      home: homedir(),
      pending: s.repos.pending,
    }) satisfies ServerMsg;

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
      noteShellOrigin: opts.noteShellOrigin,
      bootstrap: helloFrame,
    }),
    websocket: {
      // a chat frame can carry IMAGES_PER_MESSAGE images of IMAGE_MAX_BYTES each, base64; Bun's
      // default (16 MB) would drop the socket mid-paste
      maxPayloadLength: 64 * 1024 * 1024,
      async open(ws: ServerWebSocket<WsData>) {
        if (!ws.data.authed) {
          ws.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
          return;
        }
        sockets.add(ws);
        send(ws, await helloFrame());
      },
      close(ws: ServerWebSocket<WsData>) {
        sockets.delete(ws);
      },
      async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        // closed in `open`; a frame that raced the close is not a client
        if (!ws.data.authed) return;
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
          watchTerminal: (id: string, stream: string) => {
            ws.data.terms.add(streamKey(id, stream));
          },
          unwatchTerminal: (id: string, stream: string) => {
            const key = streamKey(id, stream);
            ws.data.terms.delete(key);
            ws.data.dropped.delete(key);
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
