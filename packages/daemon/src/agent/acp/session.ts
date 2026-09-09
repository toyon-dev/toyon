// One agent session per worktree over ACP. The adapter process is spawned on the first prompt and
// reaped a few minutes after the last turn ends, so idle worktrees cost nothing; the next prompt
// respawns it and resumes the agent's own session (session/load) when the agent supports that.
// The transcript JSONL is the source of truth for rendering; the agent's session id only serves
// resume. Two layers on purpose: a Conn (process + initialize) that logging in and side questions
// need, and a Live session on top of it that the chat turns use.

import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCommand,
  AgentEvent,
  AgentStatus,
  AskAnswer,
  AskChoice,
  AskOutcome,
  AuthMethodInfo,
  ImageInput,
  PasteInput,
  PickMeta,
} from "@toyon/shared";
import { UserError } from "../../core/errors.ts";
import { fireAndForget, log } from "../../core/log.ts";
import type { AuthObservation } from "../accounts.ts";
import type { AgentAdapter, AskReply, AuthOutcome, SendOpts } from "../adapter.ts";
import type { AttachmentStore, StoredImage, StoredPaste } from "../attachments.ts";
import { decide, pickOption } from "../policy.ts";
import { buildPrompt, SYSTEM_APPEND } from "../prompt.ts";
import type { AgentSpec } from "../registry.ts";
import { type Bounds, worktreeBounds, writeClaudeLocalSettings } from "../sandbox.ts";
import { Transcript, type TranscriptEntry, transcriptPathFor } from "../transcript.ts";
import { askOnce } from "./ask.ts";
import { AUTH_STATUS_UPDATE_METHOD, parseAuthStatus, supportsLogout } from "./authstatus.ts";
import { parseForm, toContent } from "./elicit.ts";
import { mapCommands, mapStopReason, mapUpdate, type ToolMemos } from "./map.ts";
import { STEER_METHOD, type SteerOutcome, steerOutcome, supportsSteering } from "./steering.ts";
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
  /** where attached images are written before the prompt carries them */
  attachments: AttachmentStore;
  getSessionId: () => string | undefined;
  setSessionId: (id: string) => void;
  onEvent: AgentEventListener;
  onStatus: AgentStatusListener;
  /** whatever this connection learns about the agent's credentials, for the per-agent cache */
  onAuth?: (agentId: string, o: AuthObservation) => void;
  /** what the `/` menu shows before this worktree's own agent has advertised anything */
  seedCommands?: () => AgentCommand[];
  /** the list this agent advertised, kept for the next worktree on the same repo */
  onCommandsLearned?: (commands: AgentCommand[]) => void;
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

/** the adapter process, initialized: enough to log in and to ask side questions */
interface Conn {
  link: AcpLink;
  ctx: acp.ClientContext;
  spec: AgentSpec;
  bounds: Bounds;
  authMethods: acp.AuthMethod[];
  loadSession: boolean;
  closeSupported: boolean;
  /** promptCapabilities.image from initialize: whether image blocks may go in a prompt */
  acceptsImages: boolean;
  /** `_meta.steering` from initialize: whether a message may join the turn already running */
  steering: boolean;
  /** side sessions (ask): text listeners by session id */
  side: Map<string, (text: string) => void>;
  /** commands pushed per session id, including sessions we have not adopted yet. Adapters send
   * available_commands_update as soon as a session exists, which is before session/new resolves
   * and for ask sessions too, so the id is the only reliable way to tell whose list this is. */
  commands: Map<string, AgentCommand[]>;
}

/** the worktree's conversation on that connection */
interface Live {
  conn: Conn;
  sessionId: string;
  /** SYSTEM_APPEND still owed to the first prompt (agents without a system-prompt override) */
  prefixPending: boolean;
  tools: ToolMemos;
}

/** the attachments written and the bubble emitted: what a message needs before it can go out on
 * any path. Held on the item so a message that changes path — steered at a turn that settled first,
 * or sent again after a login — is recorded once and keeps the attachment numbers it was shown with. */
interface Recorded {
  images: StoredImage[];
  pastes: StoredPaste[];
}

interface QueueItem {
  text: string;
  context?: string;
  pick?: PickMeta;
  images?: ImageInput[];
  pastes?: PasteInput[];
  recorded?: Recorded;
}

/** what the end event keeps of the answer, so a reload can read the card back */
function recorded(reply?: AskReply): { answers?: AskAnswer[]; choiceId?: string } {
  if (reply?.kind === "choice") return { choiceId: reply.choiceId };
  return reply?.kind === "answers" && reply.answers ? { answers: reply.answers } : {};
}

/** one open ask card. `settle` is the only way out: it answers the agent's request, appends the
 * end event and forgets the card, and it is safe to call twice (the loser of a race does nothing). */
interface PendingAsk {
  settle: (outcome: AskOutcome, reply?: AskReply) => void;
}

export class AcpSession implements AgentAdapter {
  status: AgentStatus = "idle";
  private queue: QueueItem[] = [];
  /** the message refused for want of credentials; sent again after a login */
  private refused: QueueItem | null = null;
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
  /** ask cards waiting on a person, by ask id. The agent's request stays open on the wire until
   * one of these settles, and that is what blocks its turn. */
  private asks = new Map<string, PendingAsk>();
  private log: Transcript;
  /** last image number handed out in this worktree's session; continues across daemon restarts
   * because the transcript remembers every image sent */
  private imageSeq: number;
  /** the same for pastes; the two are numbered separately and cannot collide in the store */
  private pasteSeq: number;
  /** the live session's advertised commands. Deliberately not a transcript event: the backfill is
   * the last 1000 entries, so a long session would trim the list away. An instance field survives
   * the adapter reap, which is the point; it starts empty again after a daemon restart. */
  private commandList: AgentCommand[] = [];

  constructor(private d: AcpSessionDeps) {
    // the real list only arrives once the adapter is up, which is this worktree's first prompt.
    // Until then the last one this agent gave for this repo is a far better answer than nothing.
    this.commandList = d.seedCommands?.() ?? [];
    this.log = new Transcript(transcriptPathFor(d.transcriptsDir, d.worktreeId), d.worktreeId);
    this.imageSeq = 0;
    this.pasteSeq = 0;
    // a card the daemon died under: the adapter process went with it, so nothing is listening for
    // an answer. Close it here rather than let the next backfill draw a live-looking question that
    // can never be answered. Idempotent, since these end events close the set on the next boot.
    const open = new Set<string>();
    for (const { event } of this.log.entries) {
      if (event.type === "agent-question" || event.type === "agent-permission") open.add(event.id);
      else if (event.type === "agent-ask-end") open.delete(event.id);
      if (event.type !== "user-message") continue;
      for (const img of event.images ?? []) this.imageSeq = Math.max(this.imageSeq, img.n);
      for (const p of event.pastes ?? []) this.pasteSeq = Math.max(this.pasteSeq, p.n);
    }
    for (const id of open) this.emit({ type: "agent-ask-end", id, outcome: "expired", ts: Date.now() });
  }

  get commands(): AgentCommand[] {
    return this.commandList;
  }
  onCommandsChange: ((commands: AgentCommand[]) => void) | null = null;

  /**
   * Start the session early, purely so its command list exists.
   *
   * The list only arrives once the adapter is up, which is otherwise a worktree's first prompt: a
   * `/` menu would be empty until after the thing it is meant to help write. This is the same
   * session that first message would have created, so nothing is wasted, and the answer is cached
   * per agent and repo, so it happens about once per repo rather than once per worktree.
   *
   * Best effort by design: an agent that will not start (no credentials, say) leaves the menu
   * saying so, and the person finds out properly when they send something.
   */
  async warmCommands(): Promise<void> {
    if (this.commandList.length > 0 || this.stopped) return;
    try {
      await this.ensureLive();
      // nothing is running, so let the idle reaper take the process back on its usual schedule
      this.maybeArmReaper();
    } catch (e) {
      log.debug(this.d.worktreeId, `commands warm-up skipped: ${this.describe(e)}`);
    }
  }

  private setCommands(next: AgentCommand[]) {
    // adapters re-push an unchanged list on every session start; do not wake the shell for it
    if (sameCommands(this.commandList, next)) return;
    this.commandList = next;
    this.d.onCommandsLearned?.(next);
    this.onCommandsChange?.(next);
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

  send(text: string, opts: SendOpts = {}) {
    if (this.stopped) return log.warn(this.d.worktreeId, "send after close dropped");
    const { context, pick, images, pastes } = opts;
    const item: QueueItem = {
      text,
      context,
      pick,
      ...(images?.length ? { images } : {}),
      ...(pastes?.length ? { pastes } : {}),
    };
    // sending during a turn means "while you are doing that": an agent that takes steering reads the
    // message as part of the work it is already on, which is the whole reason a person types then.
    // A stop already on its way is the exception — that turn is going away, so the message waits.
    if (this.running && !this.interrupted && this.live?.conn.steering) {
      return fireAndForget(this.d.worktreeId, this.steer(item), "agent steer");
    }
    this.enqueue(item);
  }

  private enqueue(item: QueueItem) {
    this.queue.push(item);
    this.queueChanged();
    if (!this.running) fireAndForget(this.d.worktreeId, this.drain(), "agent drain");
  }

  /** A message that joins the turn in flight. The agent settles that turn once, at its real end, so
   * the running prompt keeps owning turn-start and turn-end; all this adds to the transcript is the
   * person's own bubble, in the place they sent it. */
  private async steer(item: QueueItem) {
    item.recorded ??= await this.record(item);
    const live = this.live;
    // writing the attachments is a window the turn can settle in, and then this is a plain message
    if (!live || !this.running || this.interrupted) return this.enqueue(item);
    let outcome: SteerOutcome;
    try {
      outcome = steerOutcome(
        await live.conn.ctx.request(STEER_METHOD, {
          sessionId: live.sessionId,
          prompt: buildPrompt(
            item.text,
            item.context,
            undefined,
            this.carriedImages(live, item.recorded.images),
            item.recorded.pastes,
          ),
          // the turn can also end on the wire: ask for the message back rather than let the agent
          // prompt itself with it, since nothing here would be tracking a turn it started alone
          _meta: { steering: { idleBehavior: "promptRequired" } },
        }),
      );
    } catch (e) {
      // nothing was injected: both adapters validate the request before they push anything
      log.warn(this.d.worktreeId, "steering failed; the message goes as its own turn", e);
      return this.enqueue(item);
    }
    if (outcome === "promptRequired") return this.enqueue(item);
    if (outcome === "startedNewTurn") {
      // an agent that ignored the opt-in and prompted itself. Sending it again would run the same
      // message twice and cancelling could take the new turn with it, so the agent keeps it: what
      // is lost is the turn's framing, and status reads idle a beat early. Hold the reaper off it.
      this.clearReaper();
      log.warn(this.d.worktreeId, "steered message started a turn of the agent's own");
    }
  }

  /** Interrupt the running turn and drop anything queued. Context up to the interrupt persists
   * in the agent's session; the next message resumes from there. */
  stop() {
    this.queue = [];
    this.queueChanged();
    // before the running guard and before session/cancel: an open card is the thing holding the
    // turn open, so the agent unblocks on our answer whether or not its own cancel reaches it
    this.cancelAsks();
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
    let item: QueueItem | null = null;
    try {
      while (this.queue.length > 0 && !this.interrupted) {
        item = this.queue.shift()!;
        this.queueChanged();
        await this.runTurn(item);
      }
      this.setStatus("idle");
    } catch (e) {
      if (this.interrupted) {
        this.emit({ type: "turn-end", stopReason: "interrupted", ts: Date.now() });
        this.setStatus("idle");
      } else if (this.conn && (isAuthRequired(e) || this.rejectedCredential(e))) {
        const rejected = !isAuthRequired(e);
        // a refused credential is a plain turn failure, so the provider's own words go out first:
        // without them "not logged in" would contradict an agent that thinks it is
        if (rejected) this.emit({ type: "agent-error", message: this.describe(e), ts: Date.now() });
        // the process stays: a login runs over the same connection, then the message goes again
        this.refused = item;
        this.emit({
          type: "agent-auth-required",
          agent: this.conn.spec.id,
          agentName: this.conn.spec.name,
          methods: this.conn.authMethods.map(authMethodInfo),
          ...(rejected ? { rejected: true } : {}),
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
    // back through send(), which records it again: the message is shown a second time, above the
    // turn the login finally lets it start
    if (item) this.send(item.text, item);
  }

  /** worth offering the login methods for: the agent has a credential and the provider refused it.
   * Only asked when a connection is up, and only when that connection offered a way back in. */
  private rejectedCredential(e: unknown): boolean {
    if (!this.conn?.authMethods.length) return false;
    return REJECTED_CREDENTIAL_RE.test(e instanceof Error ? e.message : String(e));
  }

  private describe(e: unknown): string {
    if (isAuthRequired(e)) return this.conn?.spec.loginHint ?? this.d.spec().loginHint;
    const message = e instanceof Error ? e.message : String(e);
    // the SDK's generic close message; the process's own exit is the useful part
    return /connection closed/i.test(message) ? (this.conn?.link.exitInfo() ?? message) : message;
  }

  /** write the attachments and show the message. Numbered and written in send order before anything
   * is shown, so the bubble and the prompt agree on "image N" and "pasted text N". */
  private async record({ text, pick, images, pastes }: QueueItem): Promise<Recorded> {
    const stored: StoredImage[] = [];
    for (const img of images ?? [])
      stored.push(await this.d.attachments.putImage(this.d.worktreeId, ++this.imageSeq, img));
    const storedPastes: StoredPaste[] = [];
    for (const p of pastes ?? [])
      storedPastes.push(await this.d.attachments.putText(this.d.worktreeId, ++this.pasteSeq, p.text, p.name));
    this.emit({
      type: "user-message",
      text,
      ts: Date.now(),
      pick,
      ...(stored.length ? { images: stored.map((s) => s.ref) } : {}),
      ...(storedPastes.length ? { pastes: storedPastes.map((p) => p.ref) } : {}),
    });
    return { images: stored, pastes: storedPastes };
  }

  /** the images this connection will take, and the visible note when it will not take them */
  private carriedImages(live: Live, stored: StoredImage[]): StoredImage[] {
    if (!stored.length || live.conn.acceptsImages) return stored;
    // visible rather than silent: the text still goes, the person sees why the image did not
    this.emit({
      type: "agent-error",
      message: `${live.conn.spec.name} does not accept images; the message went without ${stored.length === 1 ? "it" : "them"}`,
      ts: Date.now(),
    });
    return [];
  }

  private async runTurn(item: QueueItem) {
    item.recorded ??= await this.record(item);
    this.emit({ type: "turn-start", ts: Date.now() });
    const live = await this.ensureLive();
    const carried = this.carriedImages(live, item.recorded.images);
    const prefix = live.prefixPending ? SYSTEM_APPEND : undefined;
    live.prefixPending = false;
    const res = await live.conn.ctx.request(acp.methods.agent.session.prompt, {
      sessionId: live.sessionId,
      prompt: buildPrompt(item.text, item.context, prefix, carried, item.recorded.pastes),
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
    const commands = new Map<string, AgentCommand[]>();
    const app = acp
      .client({ name: "toyon" })
      .onRequest(acp.methods.client.session.requestPermission, (c) => this.onPermission(c.params, bounds))
      .onRequest(acp.methods.client.elicitation.create, (c) => this.onElicit(c.params, c.signal))
      .onNotification(acp.methods.client.session.update, (c) => this.onUpdate(c.params, side, commands))
      // the agent pushes its identity unasked, here and whenever it changes; settings shows the last one
      .onNotification(AUTH_STATUS_UPDATE_METHOD, parseAuthStatus, (c) => {
        if (c.params) this.d.onAuth?.(spec.id, { status: c.params });
      });
    const link = this.d.connect(app, spec);
    const ctx = link.conn.agent;
    // the process dying while idle must not leave a dead handle for the next prompt to use
    link.exited.then(() => {
      if (this.conn?.link === link) {
        log.warn(this.d.worktreeId, "agent process exited while idle");
        this.conn = null;
        this.live = null;
        this.cancelAsks();
      }
    });
    try {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          // no client fs: the agent edits with its own tools, which the sandbox + policy confine
          fs: { readTextFile: false, writeTextFile: false },
          // form elicitation is how an adapter bridges its ask-the-user tool; the Claude adapter
          // drops AskUserQuestion from the model's tool list entirely without it. `url` stays
          // unadvertised: it is for sending someone to a browser mid-turn, which toyon cannot do.
          elicitation: { form: {} },
        },
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
        acceptsImages: init.agentCapabilities?.promptCapabilities?.image === true,
        steering: supportsSteering(init),
        side,
        commands,
      };
      this.d.onAuth?.(spec.id, { canLogout: supportsLogout(init.agentCapabilities) });
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
    // the push that landed while session/new was in flight, now that the id is known. Only when
    // there is one: an agent that does not re-push on resume keeps the list it already had.
    const pushed = conn.commands.get(sessionId!);
    if (pushed) this.setCommands(pushed);
    return this.live;
  }

  private onUpdate(
    params: acp.SessionNotification,
    side: Map<string, (text: string) => void>,
    commands: Map<string, AgentCommand[]>,
  ) {
    // ahead of both guards below: the list arrives before session/new resolves (so `live` is still
    // null) and again during a session/load replay (so `loading` is true). Buffered rather than
    // published, because an ask session's list lands before askOnce has registered its id in
    // `side` and must not win over the worktree's own.
    if (params.update.sessionUpdate === "available_commands_update") {
      const mapped = mapCommands(params.update.availableCommands);
      commands.set(params.sessionId, mapped);
      if (this.live && params.sessionId === this.live.sessionId) this.setCommands(mapped);
      return;
    }
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

  private onPermission(
    params: acp.RequestPermissionRequest,
    bounds: Bounds,
  ): acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse> {
    const verdict = decide(params, bounds, this.d.cwd);
    if (verdict.kind === "prompt") return this.askPermission(params);
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

  /** a decision toyon will not make for the person: draw the agent's own options as a card and
   * hold its request open until one is clicked */
  private askPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const choices: AskChoice[] = params.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }));
    // the two agents put the plan in different places: Claude's ExitPlanMode renders it as a text
    // content block, Codex's plan review sends only rawInput.plan. Without the fallback the card
    // would show Codex a title and no plan to decide on.
    const fromContent = params.toolCall.content
      ?.map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : ""))
      .filter(Boolean)
      .join("\n\n");
    const raw = (params.toolCall.rawInput as { plan?: unknown } | undefined)?.plan;
    const detail = fromContent || (typeof raw === "string" ? raw : "");
    return this.openAsk<acp.RequestPermissionResponse>(
      (id) => ({
        type: "agent-permission",
        id,
        title: params.toolCall.title ?? params.toolCall.name ?? "the agent needs a decision",
        ...(detail ? { detail } : {}),
        choices,
        ...(params.toolCall.toolCallId ? { toolId: params.toolCall.toolCallId } : {}),
        ts: Date.now(),
      }),
      (_outcome, reply) => {
        const picked = reply?.kind === "choice" ? reply.choiceId : undefined;
        return picked && choices.some((c) => c.id === picked)
          ? { outcome: { outcome: "selected", optionId: picked } }
          : { outcome: { outcome: "cancelled" } };
      },
    );
  }

  private onElicit(
    params: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): acp.CreateElicitationResponse | Promise<acp.CreateElicitationResponse> {
    const live = this.live;
    // a side session (naming, batch planning) shares this connection and has no chat to draw a
    // card in; neither does a request-scoped elicitation, which names a request and not a session
    if (!live || !("sessionId" in params) || params.sessionId !== live.sessionId) {
      log.warn(this.d.worktreeId, "elicitation with no chat behind it; declined");
      return { action: "decline" };
    }
    const form = parseForm(params);
    if (!form) {
      // an MCP server's own form: free text, a number, a date. Declining is the protocol's "the
      // person passed", which both bridges carry on from; an agent-error row would read as a
      // toyon bug in the middle of a turn that is going fine.
      log.warn(this.d.worktreeId, `elicitation toyon cannot draw as choices; declined: ${params.message}`);
      return { action: "decline" };
    }
    // the union's custom-mode arm is an open record, so this is `unknown` until it is checked
    const toolId = typeof params.toolCallId === "string" ? params.toolCallId : undefined;
    return this.openAsk<acp.CreateElicitationResponse>(
      (id) => ({
        type: "agent-question",
        id,
        message: params.message,
        questions: form.questions,
        ...(toolId ? { toolId } : {}),
        ts: Date.now(),
      }),
      (outcome, reply) => {
        const answers = reply?.kind === "answers" ? reply.answers : undefined;
        if (outcome === "answered" && answers) return { action: "accept", content: toContent(form, answers) };
        // decline is "skipped" to the agent (it hears the person passed and carries on); cancel
        // aborts the tool call, which is what a stopped turn means
        return outcome === "skipped" ? { action: "decline" } : { action: "cancel" };
      },
      signal,
    );
  }

  /** the shared half of both ask kinds: emit the card, park the resolver, and make sure every way
   * out settles the agent's request exactly once */
  private openAsk<R>(
    card: (id: string) => AgentEvent,
    respond: (outcome: AskOutcome, reply?: AskReply) => R,
    signal?: AbortSignal,
  ): Promise<R> {
    const id = randomUUID();
    return new Promise<R>((resolve) => {
      const settle = (outcome: AskOutcome, reply?: AskReply) => {
        if (!this.asks.delete(id)) return;
        signal?.removeEventListener("abort", onAbort);
        this.emit({ type: "agent-ask-end", id, outcome, ...recorded(reply), ts: Date.now() });
        this.syncStatus();
        resolve(respond(outcome, reply));
      };
      const onAbort = () => settle("cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.asks.set(id, { settle });
      this.emit(card(id));
      this.syncStatus();
    });
  }

  answer(askId: string, reply: AskReply) {
    const ask = this.asks.get(askId);
    // two shells can watch one worktree; the other one answering first is normal, not an error
    if (!ask) return log.debug(this.d.worktreeId, `answer for an ask that already closed (${askId})`);
    ask.settle(reply.kind === "answers" && !reply.answers ? "skipped" : "answered", reply);
  }

  /** every open card goes away with the turn or the process it belonged to */
  private cancelAsks() {
    for (const ask of [...this.asks.values()]) ask.settle("cancelled");
  }

  /** a card is opened inside a running turn, so the turn's own status would say "working" while
   * the agent is in fact blocked on a person */
  private syncStatus() {
    if (this.status === "error") return;
    this.setStatus(this.asks.size > 0 ? "waiting" : this.running ? "working" : "idle");
  }

  private maybeArmReaper() {
    if (!this.running && !this.asking && this.asks.size === 0 && this.conn && !this.stopped) this.armReaper();
  }

  private armReaper() {
    this.clearReaper();
    const t = setTimeout(() => {
      this.reaper = null;
      if (this.running || this.asking || this.asks.size > 0 || !this.conn) return;
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
    // closing the connection aborts outbound requests only, so a card the agent is blocked on
    // would otherwise sit here forever with no process left to answer
    this.cancelAsks();
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

/** ACP's auth_required code means "no credential"; a credential the provider rejected has no code
 * of its own and arrives as the failed turn's text, so the provider's wording is all there is to
 * read. Kept to phrasings that can only be about credentials — a 403 is usually about permission
 * or quota, and asking someone to log in again would not help. */
const REJECTED_CREDENTIAL_RE =
  /\b401\b|unauthorized|invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?(error|failed)|api key (is )?(invalid|expired|incorrect)|incorrect api key|(token|credential)s? (have |has )?expired|expired (token|credential)|not (logged in|authenticated)/i;

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

function sameCommands(a: AgentCommand[], b: AgentCommand[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.name === b[i]?.name && c.description === b[i]?.description && c.hint === b[i]?.hint)
  );
}
