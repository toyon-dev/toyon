// One agent session per worktree over ACP. The adapter process is spawned on the first prompt and
// reaped a few minutes after the last turn ends, so idle worktrees cost nothing; the next prompt
// respawns it and resumes the agent's own session (session/load) when the agent supports that.
// The transcript JSONL is the source of truth for rendering; the agent's session id only serves
// resume. Two layers on purpose: a Conn (process + initialize) that logging in and side questions
// need, and a Live session on top of it that the chat turns use.

import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, AgentStatus, AuthMethodInfo, PickMeta } from "@toyon/shared";
import { UserError } from "../../core/errors.ts";
import { fireAndForget, log } from "../../core/log.ts";
import type { AgentAdapter, AuthOutcome } from "../adapter.ts";
import { decide, pickOption } from "../policy.ts";
import { buildPrompt, SYSTEM_APPEND } from "../prompt.ts";
import type { AgentSpec } from "../registry.ts";
import { type Bounds, worktreeBounds, writeClaudeLocalSettings } from "../sandbox.ts";
import { Transcript, type TranscriptEntry, transcriptPathFor } from "../transcript.ts";
import { askOnce } from "./ask.ts";
import { mapStopReason, mapUpdate, type ToolMemos } from "./map.ts";
import type { AcpLink } from "./transport.ts";

export type AgentEventListener = (event: AgentEvent, seq: number) => void;
export type AgentStatusListener = (status: AgentStatus) => void;

export interface AcpSessionDeps {
  worktreeId: string;
  cwd: string;
  /** resolved at spawn time, so a worktree stamped with an agent after creation still gets it */
  spec: () => AgentSpec;
  /** spawn (or, in tests, connect in-process) the agent for this client app */
  connect: (app: acp.ClientApp, spec: AgentSpec) => AcpLink;
  /** the command line that starts the adapter (terminal-type login methods run it with extra args) */
  launch: (spec: AgentSpec) => { command: string; args: string[] };
  transcriptsDir: string;
  getSessionId: () => string | undefined;
  setSessionId: (id: string) => void;
  onEvent: AgentEventListener;
  onStatus: AgentStatusListener;
  /** how long an idle adapter process lives after its last turn */
  idleMs?: number;
  /** the worktree's write bounds, and the settings file that makes Claude Code enforce them */
  prepare?: (cwd: string, spec: AgentSpec) => Promise<Bounds>;
}

const DEFAULT_IDLE_MS = Number(process.env.TOYON_AGENT_IDLE_MS) || 5 * 60_000;

async function defaultPrepare(cwd: string, spec: AgentSpec): Promise<Bounds> {
  const bounds = await worktreeBounds(cwd);
  if (spec.confinement === "claude-settings") await writeClaudeLocalSettings(cwd, bounds);
  else if (spec.confinement === "none") log.warn(cwd, `agent ${spec.id} runs without an OS sandbox`);
  return bounds;
}

type Item = { text: string; context?: string; pick?: PickMeta };

/** the adapter process, initialized: enough to log in and to ask side questions */
interface Conn {
  link: AcpLink;
  ctx: acp.ClientContext;
  spec: AgentSpec;
  bounds: Bounds;
  authMethods: acp.AuthMethod[];
  loadSession: boolean;
  closeSupported: boolean;
  /** side sessions (ask): text listeners by session id */
  side: Map<string, (text: string) => void>;
}

/** the worktree's conversation on that connection */
interface Live {
  conn: Conn;
  sessionId: string;
  /** SYSTEM_APPEND still owed to the first prompt (agents without a system-prompt override) */
  prefixPending: boolean;
  tools: ToolMemos;
}

export class AcpSession implements AgentAdapter {
  status: AgentStatus = "idle";
  private queue: Item[] = [];
  /** the message refused for want of credentials; sent again after a login */
  private refused: Item | null = null;
  private running = false;
  private interrupted = false;
  private stopped = false;
  private conn: Conn | null = null;
  /** the spawn in flight, shared by whoever asks for the connection meanwhile */
  private connecting: Promise<Conn> | null = null;
  private live: Live | null = null;
  /** session/load replays the history as updates; nothing from before the load resolves is new */
  private loading = false;
  private reaper: ReturnType<typeof setTimeout> | null = null;
  /** questions in flight on side sessions; the reaper waits for them */
  private asking = 0;
  private log: Transcript;

  constructor(private d: AcpSessionDeps) {
    this.log = new Transcript(transcriptPathFor(d.transcriptsDir, d.worktreeId), d.worktreeId);
  }

  get queueLength() {
    return this.queue.length;
  }

  get queueItems(): string[] {
    return this.queue.map((q) => q.text);
  }

  onQueueChange: (() => void) | null = null;

  private queueChanged() {
    this.onQueueChange?.();
  }

  unqueue(index: number) {
    if (index >= 0 && index < this.queue.length) {
      this.queue.splice(index, 1);
      this.queueChanged();
    }
  }

  transcript(): TranscriptEntry[] {
    return this.log.entries;
  }

  private emit(event: AgentEvent) {
    const entry = this.log.append(event);
    this.d.onEvent(event, entry.seq);
  }

  private setStatus(s: AgentStatus) {
    this.status = s;
    this.d.onStatus(s);
  }

  send(text: string, context?: string, pick?: PickMeta) {
    if (this.stopped) return log.warn(this.d.worktreeId, "send after close dropped");
    this.queue.push({ text, context, pick });
    this.queueChanged();
    if (!this.running) fireAndForget(this.d.worktreeId, this.drain(), "agent drain");
  }

  /** Interrupt the running turn and drop anything queued. Context up to the interrupt persists
   * in the agent's session; the next message resumes from there. */
  stop() {
    this.queue = [];
    this.queueChanged();
    if (!this.running) return;
    this.interrupted = true;
    const live = this.live;
    if (live) {
      fireAndForget(
        this.d.worktreeId,
        live.conn.ctx.notify(acp.methods.agent.session.cancel, { sessionId: live.sessionId }),
        "cancel",
      );
    }
  }

  /** the worktree is going away (or the daemon is): kill the process, remember nothing new */
  async close(): Promise<void> {
    this.stopped = true;
    this.clearReaper();
    this.stop();
    await this.dropConn();
    await this.log.flush();
  }

  private async drain() {
    this.running = true;
    this.clearReaper();
    this.setStatus("working");
    let item: Item | null = null;
    try {
      while (this.queue.length > 0 && !this.interrupted) {
        item = this.queue.shift()!;
        this.queueChanged();
        await this.runTurn(item.text, item.context, item.pick);
      }
      this.setStatus("idle");
    } catch (e) {
      if (this.interrupted) {
        this.emit({ type: "turn-end", stopReason: "interrupted", ts: Date.now() });
        this.setStatus("idle");
      } else if (isAuthRequired(e) && this.conn) {
        // the process stays: a login runs over the same connection, then the message goes again
        this.refused = item;
        this.emit({
          type: "agent-auth-required",
          agent: this.conn.spec.id,
          agentName: this.conn.spec.name,
          methods: this.conn.authMethods.map(authMethodInfo),
          ts: Date.now(),
        });
        this.setStatus("error");
      } else {
        this.emit({ type: "agent-error", message: this.describe(e), ts: Date.now() });
        this.setStatus("error");
        // whatever state the adapter is in, the next prompt starts from a fresh process
        fireAndForget(this.d.worktreeId, this.dropConn(), "drop agent after error");
      }
    } finally {
      this.interrupted = false;
      this.running = false;
      this.maybeArmReaper();
    }
  }

  async ask(system: string, prompt: string): Promise<string | null> {
    if (this.stopped) return null;
    this.asking++;
    this.clearReaper();
    try {
      const conn = await this.ensureConn();
      return await askOnce(conn.ctx, {
        cwd: this.d.cwd,
        system,
        prompt,
        spec: conn.spec,
        route: (id, onText) => {
          conn.side.set(id, onText);
          return () => conn.side.delete(id);
        },
        closeSupported: conn.closeSupported,
        tag: this.d.worktreeId,
      });
    } catch (e) {
      log.warn(this.d.worktreeId, "ask failed", e);
      return null;
    } finally {
      this.asking--;
      this.maybeArmReaper();
    }
  }

  async authenticate(methodId: string, apiKey?: string): Promise<AuthOutcome> {
    const conn = await this.ensureConn();
    const method = conn.authMethods.find((m) => m.id === methodId);
    if (!method) throw new UserError(`${conn.spec.name} offers no login method "${methodId}"`);
    if ("type" in method && method.type === "terminal") {
      const l = this.d.launch(conn.spec);
      return { kind: "terminal", line: [l.command, ...l.args, ...(method.args ?? [])].map(shellQuote).join(" ") };
    }
    try {
      await conn.ctx.request(acp.methods.agent.authenticate, {
        methodId,
        ...(apiKey ? { _meta: { "api-key": { apiKey } } } : {}),
      });
    } catch (e) {
      throw new UserError(`${conn.spec.name} login failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.emit({ type: "agent-auth-ok", ts: Date.now() });
    this.retry();
    return { kind: "done" };
  }

  retry() {
    const item = this.refused;
    this.refused = null;
    if (item) this.send(item.text, item.context, item.pick);
  }

  private describe(e: unknown): string {
    if (isAuthRequired(e)) return this.conn?.spec.loginHint ?? this.d.spec().loginHint;
    const message = e instanceof Error ? e.message : String(e);
    // the SDK's generic close message; the process's own exit is the useful part
    return /connection closed/i.test(message) ? (this.conn?.link.exitInfo() ?? message) : message;
  }

  private async runTurn(text: string, context?: string, pick?: PickMeta) {
    this.emit({ type: "user-message", text, ts: Date.now(), pick });
    this.emit({ type: "turn-start", ts: Date.now() });
    const live = await this.ensureLive();
    const prefix = live.prefixPending ? SYSTEM_APPEND : undefined;
    live.prefixPending = false;
    const res = await live.conn.ctx.request(acp.methods.agent.session.prompt, {
      sessionId: live.sessionId,
      prompt: buildPrompt(text, context, prefix),
    });
    this.emit({ type: "turn-end", stopReason: mapStopReason(res.stopReason), ts: Date.now() });
  }

  /** the adapter process, spawned and initialized once; concurrent callers share the spawn */
  private ensureConn(): Promise<Conn> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    this.connecting = this.openConn().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openConn(): Promise<Conn> {
    const spec = this.d.spec();
    const bounds = await (this.d.prepare ?? defaultPrepare)(this.d.cwd, spec);
    const side = new Map<string, (text: string) => void>();
    const app = acp
      .client({ name: "toyon" })
      .onRequest(acp.methods.client.session.requestPermission, (c) => this.onPermission(c.params, bounds))
      .onNotification(acp.methods.client.session.update, (c) => this.onUpdate(c.params, side));
    const link = this.d.connect(app, spec);
    const ctx = link.conn.agent;
    // the process dying while idle must not leave a dead handle for the next prompt to use
    link.exited.then(() => {
      if (this.conn?.link === link) {
        log.warn(this.d.worktreeId, "agent process exited while idle");
        this.conn = null;
        this.live = null;
      }
    });
    try {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // no client fs: the agent edits with its own tools, which the sandbox + policy confine
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "toyon", version: "0" },
      });
      this.conn = {
        link,
        ctx,
        spec,
        bounds,
        authMethods: init.authMethods ?? [],
        loadSession: !!init.agentCapabilities?.loadSession,
        closeSupported: !!init.agentCapabilities?.sessionCapabilities?.close,
        side,
      };
      return this.conn;
    } catch (e) {
      fireAndForget(this.d.worktreeId, link.kill(), "kill agent after failed start");
      throw e;
    }
  }

  /** the worktree's session on the connection: resumed when the agent remembers it, else new */
  private async ensureLive(): Promise<Live> {
    const conn = await this.ensureConn();
    if (this.live?.conn === conn) return this.live;
    const additionalDirectories = conn.bounds.gitDir ? [conn.bounds.gitDir] : [];
    let sessionId = this.d.getSessionId();
    let modes: acp.SessionModeState | null | undefined;
    let configOptions: acp.SessionConfigOption[] | null | undefined;
    let resumed = false;
    if (sessionId && conn.loadSession) {
      this.loading = true;
      try {
        const r = await conn.ctx.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: this.d.cwd,
          mcpServers: [],
          additionalDirectories,
        });
        modes = r.modes;
        configOptions = r.configOptions;
        resumed = true;
      } catch (e) {
        if (isAuthRequired(e)) throw e;
        log.warn(this.d.worktreeId, `could not resume agent session ${sessionId}; starting a new one`, e);
      } finally {
        this.loading = false;
      }
    }
    if (!resumed) {
      const r = await conn.ctx.request(acp.methods.agent.session.new, {
        cwd: this.d.cwd,
        mcpServers: [],
        additionalDirectories,
        ...(conn.spec.systemPrompt === "meta-append" ? { _meta: { systemPrompt: { append: SYSTEM_APPEND } } } : {}),
      });
      sessionId = r.sessionId;
      modes = r.modes;
      configOptions = r.configOptions;
      if (!this.stopped) this.d.setSessionId(sessionId);
    }
    const model = configOptions?.find((o) => o.category === "model");
    this.emit({
      type: "session-info",
      sessionId: sessionId!,
      ...(model && model.type === "select" ? { model: String(model.currentValue) } : {}),
    });
    const mode = conn.spec.mode;
    if (mode && modes && modes.currentModeId !== mode && modes.availableModes.some((m) => m.id === mode)) {
      await conn.ctx.request(acp.methods.agent.session.setMode, { sessionId: sessionId!, modeId: mode });
    }
    this.live = {
      conn,
      sessionId: sessionId!,
      prefixPending: !resumed && conn.spec.systemPrompt === "prompt-prefix",
      tools: new Map(),
    };
    return this.live;
  }

  private onUpdate(params: acp.SessionNotification, side: Map<string, (text: string) => void>) {
    if (this.loading) return;
    const listener = side.get(params.sessionId);
    if (listener) {
      const u = params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") listener(u.content.text);
      return;
    }
    const live = this.live;
    if (!live || params.sessionId !== live.sessionId) {
      return log.debug(this.d.worktreeId, `acp: update for another session ${params.sessionId} dropped`);
    }
    for (const ev of mapUpdate(params.update, live.tools, this.d.worktreeId)) {
      // the mapper does not know the session id; the transcript wants the real one
      this.emit(ev.type === "session-info" ? { ...ev, sessionId: live.sessionId } : ev);
    }
  }

  private onPermission(params: acp.RequestPermissionRequest, bounds: Bounds): acp.RequestPermissionResponse {
    const verdict = decide(params, bounds, this.d.cwd);
    if (verdict.kind === "reject") {
      this.emit({
        type: "agent-blocked",
        tool: verdict.tool,
        path: verdict.path,
        reason: verdict.reason,
        ts: Date.now(),
      });
    }
    return pickOption(params.options, verdict);
  }

  private maybeArmReaper() {
    if (!this.running && !this.asking && this.conn && !this.stopped) this.armReaper();
  }

  private armReaper() {
    this.clearReaper();
    const t = setTimeout(() => {
      this.reaper = null;
      if (this.running || this.asking || !this.conn) return;
      log.debug(this.d.worktreeId, "agent idle; stopping its process");
      fireAndForget(this.d.worktreeId, this.dropConn(), "reap agent");
    }, this.d.idleMs ?? DEFAULT_IDLE_MS);
    // a sleeping timer must not keep a test (or a shutdown) waiting
    t.unref?.();
    this.reaper = t;
  }

  private clearReaper() {
    if (this.reaper) clearTimeout(this.reaper);
    this.reaper = null;
  }

  private async dropConn() {
    const conn = this.conn;
    this.conn = null;
    this.live = null;
    if (!conn) return;
    conn.link.conn.close();
    await conn.link.kill();
  }
}

function isAuthRequired(e: unknown): boolean {
  return e instanceof acp.RequestError && e.code === -32000;
}

function authMethodInfo(m: acp.AuthMethod): AuthMethodInfo {
  const terminal = "type" in m && m.type === "terminal";
  return {
    id: m.id,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    kind: terminal ? "terminal" : "agent",
    ...(!terminal && /api[-_ ]?key/i.test(`${m.id} ${m.name}`) ? { needsKey: true } : {}),
  };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
