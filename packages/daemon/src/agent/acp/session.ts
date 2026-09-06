// One agent session per worktree over ACP. The adapter process is spawned on the first prompt and
// reaped a few minutes after the last turn ends, so idle worktrees cost nothing; the next prompt
// respawns it and resumes the agent's own session (session/load) when the agent supports that.
// The transcript JSONL is the source of truth for rendering; the agent's session id only serves
// resume.

import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, AgentStatus, PickMeta } from "@toyon/shared";
import { fireAndForget, log } from "../../core/log.ts";
import type { AgentAdapter } from "../adapter.ts";
import { decide, pickOption } from "../policy.ts";
import { buildPrompt, SYSTEM_APPEND } from "../prompt.ts";
import type { AgentSpec } from "../registry.ts";
import { type Bounds, worktreeBounds, writeClaudeLocalSettings } from "../sandbox.ts";
import { Transcript, type TranscriptEntry, transcriptPathFor } from "../transcript.ts";
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

interface Live {
  link: AcpLink;
  ctx: acp.ClientContext;
  sessionId: string;
  bounds: Bounds;
  spec: AgentSpec;
  /** SYSTEM_APPEND still owed to the first prompt (agents without a system-prompt override) */
  prefixPending: boolean;
  tools: ToolMemos;
}

export class AcpSession implements AgentAdapter {
  status: AgentStatus = "idle";
  private queue: Array<{ text: string; context?: string; pick?: PickMeta }> = [];
  private running = false;
  private interrupted = false;
  private stopped = false;
  private live: Live | null = null;
  /** session/load replays the history as updates; nothing from before the load resolves is new */
  private loading = false;
  private reaper: ReturnType<typeof setTimeout> | null = null;
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
    if (live)
      fireAndForget(
        this.d.worktreeId,
        live.ctx.notify(acp.methods.agent.session.cancel, { sessionId: live.sessionId }),
        "cancel",
      );
  }

  /** the worktree is going away (or the daemon is): kill the process, remember nothing new */
  async close(): Promise<void> {
    this.stopped = true;
    this.clearReaper();
    this.stop();
    await this.dropLive();
    await this.log.flush();
  }

  private async drain() {
    this.running = true;
    this.clearReaper();
    this.setStatus("working");
    try {
      while (this.queue.length > 0 && !this.interrupted) {
        const item = this.queue.shift()!;
        this.queueChanged();
        await this.runTurn(item.text, item.context, item.pick);
      }
      this.setStatus("idle");
    } catch (e) {
      if (this.interrupted) {
        this.emit({ type: "turn-end", stopReason: "interrupted", ts: Date.now() });
        this.setStatus("idle");
      } else {
        this.emit({ type: "agent-error", message: this.describe(e), ts: Date.now() });
        this.setStatus("error");
        // whatever state the adapter is in, the next prompt starts from a fresh process
        fireAndForget(this.d.worktreeId, this.dropLive(), "drop agent after error");
      }
    } finally {
      this.interrupted = false;
      this.running = false;
      if (!this.stopped && this.live) this.armReaper();
    }
  }

  private describe(e: unknown): string {
    if (e instanceof acp.RequestError && e.code === -32000) return this.live?.spec.loginHint ?? this.d.spec().loginHint;
    const message = e instanceof Error ? e.message : String(e);
    // the SDK's generic close message; the process's own exit is the useful part
    return /connection closed/i.test(message) ? (this.live?.link.exitInfo() ?? message) : message;
  }

  private async runTurn(text: string, context?: string, pick?: PickMeta) {
    this.emit({ type: "user-message", text, ts: Date.now(), pick });
    this.emit({ type: "turn-start", ts: Date.now() });
    const live = await this.ensureLive();
    const prefix = live.prefixPending ? SYSTEM_APPEND : undefined;
    live.prefixPending = false;
    const res = await live.ctx.request(acp.methods.agent.session.prompt, {
      sessionId: live.sessionId,
      prompt: buildPrompt(text, context, prefix),
    });
    this.emit({ type: "turn-end", stopReason: mapStopReason(res.stopReason), ts: Date.now() });
  }

  private async ensureLive(): Promise<Live> {
    if (this.live) return this.live;
    const spec = this.d.spec();
    const bounds = await (this.d.prepare ?? defaultPrepare)(this.d.cwd, spec);
    const tools: ToolMemos = new Map();
    const app = acp
      .client({ name: "toyon" })
      .onRequest(acp.methods.client.session.requestPermission, (c) => this.onPermission(c.params, bounds))
      .onNotification(acp.methods.client.session.update, (c) => this.onUpdate(c.params, tools));
    const link = this.d.connect(app, spec);
    const ctx = link.conn.agent;
    // the process dying while idle must not leave a dead handle for the next prompt to use
    link.exited.then(() => {
      if (this.live?.link === link) {
        log.warn(this.d.worktreeId, "agent process exited while idle");
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
      const additionalDirectories = bounds.gitDir ? [bounds.gitDir] : [];
      let sessionId = this.d.getSessionId();
      let modes: acp.SessionModeState | null | undefined;
      let configOptions: acp.SessionConfigOption[] | null | undefined;
      let resumed = false;
      if (sessionId && init.agentCapabilities?.loadSession) {
        this.loading = true;
        try {
          const r = await ctx.request(acp.methods.agent.session.load, {
            sessionId,
            cwd: this.d.cwd,
            mcpServers: [],
            additionalDirectories,
          });
          modes = r.modes;
          configOptions = r.configOptions;
          resumed = true;
        } catch (e) {
          log.warn(this.d.worktreeId, `could not resume agent session ${sessionId}; starting a new one`, e);
        } finally {
          this.loading = false;
        }
      }
      if (!resumed) {
        const r = await ctx.request(acp.methods.agent.session.new, {
          cwd: this.d.cwd,
          mcpServers: [],
          additionalDirectories,
          ...(spec.systemPrompt === "meta-append" ? { _meta: { systemPrompt: { append: SYSTEM_APPEND } } } : {}),
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
      if (
        spec.mode &&
        modes &&
        modes.currentModeId !== spec.mode &&
        modes.availableModes.some((m) => m.id === spec.mode)
      ) {
        await ctx.request(acp.methods.agent.session.setMode, { sessionId: sessionId!, modeId: spec.mode });
      }
      this.live = {
        link,
        ctx,
        sessionId: sessionId!,
        bounds,
        spec,
        prefixPending: !resumed && spec.systemPrompt === "prompt-prefix",
        tools,
      };
      return this.live;
    } catch (e) {
      fireAndForget(this.d.worktreeId, link.kill(), "kill agent after failed start");
      throw e;
    }
  }

  private onUpdate(params: acp.SessionNotification, tools: ToolMemos) {
    if (this.loading) return;
    if (this.live && params.sessionId !== this.live.sessionId) {
      return log.debug(this.d.worktreeId, `acp: update for another session ${params.sessionId} dropped`);
    }
    for (const ev of mapUpdate(params.update, tools, this.d.worktreeId)) {
      // the mapper does not know the session id; the transcript wants the real one
      this.emit(ev.type === "session-info" && this.live ? { ...ev, sessionId: this.live.sessionId } : ev);
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

  private armReaper() {
    this.clearReaper();
    const t = setTimeout(() => {
      this.reaper = null;
      if (this.running || !this.live) return;
      log.debug(this.d.worktreeId, "agent idle; stopping its process");
      fireAndForget(this.d.worktreeId, this.dropLive(), "reap agent");
    }, this.d.idleMs ?? DEFAULT_IDLE_MS);
    // a sleeping timer must not keep a test (or a shutdown) waiting
    t.unref?.();
    this.reaper = t;
  }

  private clearReaper() {
    if (this.reaper) clearTimeout(this.reaper);
    this.reaper = null;
  }

  private async dropLive() {
    const live = this.live;
    this.live = null;
    if (!live) return;
    live.link.conn.close();
    await live.link.kill();
  }
}
