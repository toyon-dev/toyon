// WebSocket side of the daemon: socket registry, hello, inbound validation + dispatch, and the
// table of what gets pushed when a hub event fires.

import { homedir, hostname } from "node:os";
import {
  type ManagedResolved,
  machineLabel,
  managedView,
  PROTOCOL_VERSION,
  parseClientMsg,
  type Remote,
  type ServerMsg,
  SHELL_STREAM,
  streamKey,
  ThemeImportError,
  UPLOAD_MAX_BYTES,
  WS_CLOSE_UNAUTHORIZED,
} from "@toyon/shared";
import type { Server, ServerWebSocket } from "bun";
import { lacksQuickModel } from "../agent/tasks.ts";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import type { GrantCodes } from "../core/grants.ts";
import { fireAndForget, log } from "../core/log.ts";
import { lag, type SocketStats } from "../core/metrics.ts";
import { PairCodes } from "../core/pair.ts";
import { readTailnetPhones } from "../core/tailnet.ts";
import type { DraftStore } from "../drafts/store.ts";
import { setWaitingColors } from "../runtime/proxy.ts";
import { dispatch, openedFrame, type Services } from "./handlers.ts";
import { createFetch, type WsData } from "./http.ts";

/** how far behind a socket may fall before its terminal output is dropped instead of queued */
const DROP_ABOVE_BYTES = 4 * 1024 * 1024;
const DROPPED_NOTICE = "\r\n[toyon] output dropped: this pane was too far behind\r\n";

/** the frames that are a message sent from a composer box */
const SENDS = new Set(["chat", "create-worktree", "restore-worktree", "batch-worktrees"]);

/** the box a frame that did not parse was sent from, read off the raw JSON; null when it is not a
 * send, or names no box */
function sentFrom(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const { t, boxId } = json as { t?: unknown; boxId?: unknown };
  if (typeof t !== "string" || !SENDS.has(t)) return null;
  return typeof boxId === "string" && boxId.length > 0 && boxId.length <= 200 ? boxId : null;
}

/** The answer to a frame that did not parse. A send that did not parse reached nobody and took
 * nothing: its box is as the daemon holds it, and the tab that emptied its own is handed that
 * back with the reason. Anything else is told the reason alone. */
export function unparsedReply(
  json: unknown,
  reason: string,
  drafts: Pick<DraftStore, "text" | "attachments">,
): ServerMsg {
  const message = `invalid message: ${reason}`;
  const boxId = sentFrom(json);
  if (boxId === null) return { t: "error", message };
  return { t: "unsent", boxId, text: drafts.text(boxId), items: drafts.attachments(boxId), message };
}

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
  /** the link a page starts a daemon here through, when this machine has what answers it */
  startLink: () => string | null;
  /** a shell on another machine has paired here and is trusted from now on */
  onTrusted: (origin: string) => void;
  /** the one-time codes a shell on another machine spends to open a preview here */
  grants: GrantCodes;
  /** the public name and its front (core/remote.ts), or null */
  remote: Remote | null;
  /** the managed policy as read at boot: hello carries it, /health names its source and hash,
   * and the branded listener binds only where it allows */
  managed: ManagedResolved;
}

export function startServer(opts: ServerOpts): { server: Server<WsData>; branded: boolean; stop: () => void } {
  const { services: s, token, version } = opts;
  const sockets = new Set<ServerWebSocket<WsData>>();
  // every socket that was let in, shell or preview: what the daemon's own idle stop counts. A
  // preview page open on its own, with no shell, is still someone using it.
  const linked = new Set<ServerWebSocket<WsData>>();
  // the ones that came from another device, a shell or a preview page on the remote name: someone
  // is using this machine from somewhere its own keyboard cannot tell
  const counted = () => {
    s.idleExit.clients(linked.size);
    s.keepAwake.remoteShells([...linked].filter((ws) => ws.data.remote || ws.data.preview).length);
  };
  const link = (ws: ServerWebSocket<WsData>) => {
    linked.add(ws);
    counted();
  };
  const unlink = (ws: ServerWebSocket<WsData>) => {
    if (linked.delete(ws)) counted();
  };

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
      ...s.runtime.tiers(),
    },
    /** resident memory of each awake worktree's procs at the last sample, KB */
    costs: s.idle.costs(),
    /** whether updates are off for the machine, or the registry has no toyon: doctor says so */
    updates: s.update.status(),
    /** the adapter versions on disk beside the pinned ones: doctor names an upgrade that failed */
    agents: s.agents.adapters(),
    sockets: [...sockets].map(
      (ws): SocketStats => ({ subs: [...ws.data.subs], sent: ws.data.sent, bytes: ws.data.bytes }),
    ),
  });

  // ---- what a hub event pushes to clients ----
  // One frame per burst: the events of one tick (a create's save and its emit, ten proc events)
  // build one snapshot, after the tick has finished changing state. The snapshot waits on nothing,
  // so frames cannot land out of order and a send moves its row at the press.
  let statusesQueued = false;
  const worktreesChanged = () => {
    if (statusesQueued) return;
    statusesQueued = true;
    setTimeout(() => {
      statusesQueued = false;
      try {
        const { rows, trunks } = s.worktrees.snapshot();
        broadcast({ t: "worktrees", rows, trunks });
      } catch (e) {
        log.warn("ws", "worktrees broadcast failed", e);
      }
    }, 0);
  };
  s.hub.on("worktreesChanged", worktreesChanged);
  s.hub.on("agentStatus", worktreesChanged);
  s.hub.on("reposChanged", () => broadcast({ t: "repos", repos: s.state.repos }));
  s.hub.on("pendingChanged", () => broadcast({ t: "pending-repos", pending: s.repos.pending }));
  s.hub.on("proc", (worktreeId, proc) => broadcast({ t: "proc", worktreeId, proc }));
  s.hub.on("log", (worktreeId, proc, line, retract) =>
    sendTo(worktreeId, retract ? { t: "log", worktreeId, proc, line, retract } : { t: "log", worktreeId, proc, line }),
  );
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
  // a save or a discard in one tab: the writer's changes list and every other tab's follow from the
  // same push, and an editor open on the file re-reads it from there
  s.hub.on("filesChanged", refreshGitStatus);
  // a file opened from outside: every shell up now is told, and the open is done with; with none
  // up it waits for the next socket (below), since the launcher opens the window after the file
  s.hub.on("opened", (o) => {
    if (sockets.size === 0) return;
    broadcast(openedFrame(o));
    s.opens.delivered();
  });
  // a refused open names no worktree, so the shell says it under the composer on screen
  s.hub.on("openRefused", (message) => broadcast({ t: "error", message }));
  // A shell in toyon's terminal writes files and commits with nothing else noticing, so once its
  // output has gone quiet the worktree is recounted: the rail's badges and, when it is open, its
  // changes list. Quiet rather than per chunk, since a build prints thousands of them.
  const shellQuiet = new Map<string, ReturnType<typeof setTimeout>>();
  s.hub.on("termData", (worktreeId, stream) => {
    if (stream !== SHELL_STREAM) return;
    clearTimeout(shellQuiet.get(worktreeId));
    shellQuiet.set(
      worktreeId,
      setTimeout(() => {
        shellQuiet.delete(worktreeId);
        s.worktrees.invalidateCounts(worktreeId);
        worktreesChanged();
        fireAndForget(worktreeId, pushGitStatus(worktreeId), "git status after the shell went quiet");
      }, 1500),
    );
  });
  // a worktree's pages ride behind its git status: the same pushes, sent only when they moved, so the
  // route list is current before anyone opens it
  const sentPages = new Map<string, string>();
  const sendPages = (worktreeId: string, pages: Awaited<ReturnType<typeof s.routes.pages>>) => {
    const json = JSON.stringify(pages);
    if (sentPages.get(worktreeId) === json) return;
    sentPages.set(worktreeId, json);
    sendTo(worktreeId, { t: "routes", worktreeId, ...pages });
  };
  const pushGitStatus = async (worktreeId: string) => {
    if (![...sockets].some((ws) => ws.data.subs.has(worktreeId))) return;
    const info = await s.worktrees.gitStatus(worktreeId);
    if (!info) return;
    sendTo(worktreeId, { t: "git-status", worktreeId, ...info });
    sendPages(worktreeId, await s.routes.pages(worktreeId, info));
  };
  s.hub.on("pagesChanged", (worktreeId) => {
    const pages = s.routes.cached(worktreeId);
    if (pages) sendPages(worktreeId, pages);
  });
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
      const models = s.state.cachedOptions(a.id, "model");
      const efforts = s.state.cachedOptions(a.id, "thought_level");
      // whether the side questions can be put to it, so the shell says once, on its page, that
      // the commit message is the person's to write, instead of every turn under the box
      const spec = s.agents.get(a.id);
      return {
        ...a,
        ...(models.length > 0 ? { models } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(spec && !lacksQuickModel(spec, s.state) ? { quick: true as const } : {}),
      };
    });
  const agentsMsg = () =>
    ({
      t: "agents",
      agents: agentInfos(),
      defaultAgent: s.agents.defaultId(s.state.defaultAgent),
      agentChosen: s.state.defaultAgent !== undefined,
    }) satisfies ServerMsg;
  s.hub.on("agentsChanged", () => broadcast(agentsMsg()));
  s.hub.on("keepAwakeChanged", () => broadcast({ t: "keep-awake", mode: s.keepAwake.setting() }));
  s.hub.on("selfChanged", () => broadcast({ t: "self", self: s.self.get() }));
  // every tab, not the worktree's subscribers: the person who landed has moved on to some other
  // row by now, and the shell reads a main worktree's error under whichever composer is on screen
  s.hub.on("failed", (worktreeId, message) => broadcast({ t: "error", message, worktreeId }));
  s.hub.on("updateChanged", () => broadcast({ t: "update", update: s.update.get() }));
  s.hub.on("visitsChanged", (repoId) => broadcast({ t: "visits", repoId, pages: s.routes.history(repoId) }));
  s.hub.on("archiveChanged", (repoId) => broadcast({ t: "archived", repoId, items: s.worktrees.archived(repoId) }));
  // every tab, the writer included: it knows its own frame by the client id and leaves its box alone
  s.hub.on("draftChanged", (boxId, text, clientId) =>
    broadcast({ t: "draft", boxId, text, ...(clientId ? { clientId } : {}) }),
  );
  s.hub.on("attachmentsChanged", (boxId, items, clientId) =>
    broadcast({ t: "attachments", boxId, items, ...(clientId ? { clientId } : {}) }),
  );

  // What a page learns first, over the socket or over the bootstrap fetch that precedes it. The
  // rows go out from what is known and the counts follow, rather than every page load waiting on a
  // git pass across every worktree.
  const helloFrame = async () => {
    // a page load is when an install done in a terminal first matters to anyone
    await s.update.refresh();
    const { rows, trunks } = s.worktrees.snapshot();
    return {
      t: "hello",
      version,
      install: s.update.install(),
      registry: await s.update.registry(),
      protocol: PROTOCOL_VERSION,
      repos: s.state.repos,
      rows,
      trunks,
      themes: s.themes.themes,
      themePrefs: s.themes.prefs,
      agents: agentInfos(),
      defaultAgent: s.agents.defaultId(s.state.defaultAgent),
      agentChosen: s.state.defaultAgent !== undefined,
      home: homedir(),
      folderDialog: process.platform === "darwin" && !cloud.enabled,
      keepAwake: s.keepAwake.setting(),
      remote: opts.remote,
      machine: machineLabel(hostname(), opts.remote),
      paired: s.state.paired,
      gitIdentity: await s.repos.gitIdentity(),
      pending: s.repos.pending,
      visits: s.routes.historyAll(),
      self: s.self.get(),
      update: s.update.get(),
      drafts: s.drafts.all(),
      attachments: s.drafts.allAttachments(),
      managed: managedView(opts.managed),
    } satisfies ServerMsg;
  };

  let branded = false;
  const serverConfig = {
    // an upload is the largest body anything sends; the store counts the bytes that arrive too
    maxRequestBodySize: UPLOAD_MAX_BYTES,
    hostname: cloud.bindHost,
    fetch: createFetch({
      token,
      shellDist: opts.shellDist,
      version,
      repos: s.repos,
      attachments: s.attachments,
      archivedAttachment: (id, file) => s.worktrees.archivedAttachment(id, file),
      worktreeFile: (id, path) => s.files.viewableFile(id, path),
      looseFile: (id) => s.opens.viewable(id),
      branded: () => branded,
      metrics,
      noteShellOrigin: opts.noteShellOrigin,
      offline: () => ({ start: opts.startLink(), port: opts.port }),
      remote: opts.remote,
      managed: { source: opts.managed.source, hash: opts.managed.hash },
      preview: (id) => s.runtime.get(id)?.proxy?.handler ?? null,
      bootstrap: helloFrame,
      manifestColors: () => {
        const { surface0, surface1 } = s.themes.current().colors;
        return { bar: surface1, ground: surface0 };
      },
      open: (path) => s.opens.open(path),
      restart: (now) => s.restarter.request({ now }),
      restartWait: () => ({ waiting: s.restarter.waitingOn(), asking: s.restarter.asking() }),
      pair: new PairCodes(),
      grants: opts.grants,
      onPaired: (origin) => {
        // A redeem from this machine's own name is a phone's camera opening the link: the phone
        // now holds the token, which is what the bar's offer of a code was for. A redeem from a
        // page this machine did not serve is a shell elsewhere (another machine's desk, or the
        // app installed from it) that now holds the token: its origin is answered across origins
        // from here on, and the bar still owes the person's phone its code.
        const own = origin === null || origin === `https://${opts.remote?.host}`;
        if (own) s.state.notePaired();
        else {
          s.state.trustOrigin(origin);
          if (s.state.trustedOrigins.includes(origin)) opts.onTrusted(origin);
        }
        broadcast({ t: "paired" });
      },
      trusted: () => s.state.trustedOrigins,
      phones: () => readTailnetPhones(),
      mcp: (req, id) => s.mcp.fetch(req, id),
    }),
    websocket: {
      // idleTimeout and sendPings stay at Bun's defaults (120 s, on): they are what close a tab that
      // died without a word, which is what lets go of the worktree it was showing
      async open(ws: ServerWebSocket<WsData>) {
        const preview = ws.data.preview;
        if (preview) {
          link(ws);
          preview.handler.open(ws, preview.data);
          return;
        }
        if (!ws.data.authed) {
          ws.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
          return;
        }
        sockets.add(ws);
        link(ws);
        send(ws, await helloFrame());
        // what was opened from outside while no shell was up: the Dock icon's file, arriving
        // before the window it also opened
        for (const o of s.opens.takePending()) send(ws, openedFrame(o));
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.preview) ws.data.preview.handler.close(ws.data.preview.data);
        // a tab that went away without a word (a closed lid) closes here once the socket's own
        // idle timeout and pings give it up, and whatever it was showing is released with it
        else s.idle.drop(ws.data);
        sockets.delete(ws);
        unlink(ws);
      },
      async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        if (ws.data.preview) {
          ws.data.preview.handler.message(ws.data.preview.data, raw);
          return;
        }
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
          send(ws, unparsedReply(json, parsed.reason, s.drafts));
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
            if (ws.data.view === id) {
              ws.data.view = null;
              s.idle.view(ws.data, null);
            }
          },
          view: (id: string | null) => {
            ws.data.view = id;
            s.idle.view(ws.data, id);
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
          // the worktree the message named, so the shell can answer on its chat; a restore names its
          // archive, which is the same id the worktree comes back under
          const m = parsed.msg;
          const worktreeId = "worktreeId" in m ? m.worktreeId : "archiveId" in m ? m.archiveId : undefined;
          send(ws, {
            t: "error",
            message: e instanceof Error ? e.message : String(e),
            ...(worktreeId ? { worktreeId } : {}),
          });
        }
      },
    },
  };

  const server = Bun.serve<WsData, string>({ ...serverConfig, port: opts.port });
  // best-effort port 80 so the branded http://toyon.localhost works portless (macOS allows
  // unprivileged low-port binds; failure is fine, :4141 remains). A managed policy can keep it
  // off: endpoint monitoring alerts on a new wildcard listener, and IT would rather not explain it.
  let brandedServer: Server<WsData> | null = null;
  if (opts.port !== 80 && !cloud.enabled && opts.managed.policy.brandedListener) {
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
