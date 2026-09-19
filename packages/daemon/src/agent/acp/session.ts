// One agent session per worktree over ACP. The adapter process is spawned on the first prompt and
// reaped a few minutes after the last turn ends, so idle worktrees cost nothing; the next prompt
// respawns it and picks the agent's own session back up (session/resume) when the agent supports
// that. The transcript JSONL is the source of truth for rendering; the agent's session id only
// serves resume, and the agent is never asked to replay its history. Two layers on purpose: a Conn (process + initialize) that logging in and side questions
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
  AttachmentInput,
  AttachmentKind,
  AuthMethodInfo,
  ModelChoice,
  PermissionMode,
} from "@toyon/shared";
import { DEFAULT_PERMISSION_MODE, nextNumbers } from "@toyon/shared";
import { UserError } from "../../core/errors.ts";
import { fireAndForget, log } from "../../core/log.ts";
import type { AuthObservation } from "../accounts.ts";
import type { AgentAdapter, AskOpts, AskReply, AuthOutcome, SendOpts } from "../adapter.ts";
import type { AttachmentStore, Stored } from "../attachments.ts";
import { agentModeFor, modeAfterPlan } from "../modes.ts";
import { decide, decideUnattended, pickOption } from "../policy.ts";
import { ambientBlock, buildPrompt, SYSTEM_APPEND } from "../prompt.ts";
import type { AgentSpec } from "../registry.ts";
import { type Bounds, type Prepared, prepareLaunch } from "../sandbox.ts";
import { Transcript, type TranscriptEntry, transcriptPathFor } from "../transcript.ts";
import { askOnce } from "./ask.ts";
import { AUTH_STATUS_UPDATE_METHOD, parseAuthStatus, supportsLogout } from "./authstatus.ts";
import { parseForm, toContent } from "./elicit.ts";
import { endOfAsk, mapCommands, mapStopReason, mapUpdate, type ToolMemos } from "./map.ts";
import { currentValues, type LiveOptions, type OptionCategory, readModeOption, readOptions } from "./options.ts";
import { STEER_METHOD, type SteerOutcome, steerOutcome, supportsSteering } from "./steering.ts";
import type { AcpLink } from "./transport.ts";

export type AgentEventListener = (event: AgentEvent, seq: number) => void;
export type AgentStatusListener = (status: AgentStatus) => void;

export interface AcpSessionDeps {
  worktreeId: string;
  cwd: string;
  /** resolved at spawn time, so a worktree stamped with an agent after creation still gets it */
  spec: () => AgentSpec;
  /** spawn (or, in tests, connect in-process) the agent for this client app, from its prepared launch */
  connect: (app: acp.ClientApp, spec: AgentSpec, prepared: Prepared) => AcpLink;
  /** the adapter's own command line, unconfined (terminal-type login methods run it with extra args) */
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
  /** how long a turn the agent started on its own may go quiet before it is over */
  ownSettleMs?: number;
  /** the worktree's bounds, after the agent's own setup has run (agent/sandbox.ts `prepareLaunch`) */
  prepare?: (cwd: string, spec: AgentSpec) => Promise<Prepared>;
  /** what the agent may do here without asking; read before every turn and every permission */
  mode?: () => PermissionMode;
  /** a plan approval decided the mode for the work that follows */
  setMode?: (mode: PermissionMode) => void;
  /** A plan card is about to be shown, whatever becomes of it. Takes the plan's markdown and
   * answers with the worktree-relative file it was written to, or null if it was not written. */
  onPlan?: (markdown: string) => Promise<string | null>;
  /** whether the plan file the card named says something other than what the agent proposed */
  planEdited?: (path: string, proposed: string) => Promise<boolean>;
  /** the value the worktree asks for in this category (its model, its effort level); undefined
   * leaves the agent on its own default */
  option?: (category: OptionCategory) => string | undefined;
  /** what the agent advertised for the category when a session opened or the list changed, for
   * the picker. Only categories present are reported: an agent that has effort on some models
   * and not others keeps the last list it gave rather than flapping off. */
  onOptionsLearned?: (category: OptionCategory, choices: ModelChoice[]) => void;
  /** where the preview stands, as a block after every message; read as each goes out, since the
   * port belongs to the runtime and not to this session */
  preview?: () => string | undefined;
}

const DEFAULT_IDLE_MS = Number(process.env.TOYON_AGENT_IDLE_MS) || 5 * 60_000;
/** The quiet that ends a turn the agent started on its own. Between a tool's result and the next
 * call the wire carries nothing while the model reads the result, seconds on a long context; a
 * turn cut at that gap would come back as a second one, so the wait errs long. */
const OWN_SETTLE_MS = 10_000;

/** A turn the agent is running with no prompt out: the calls it has open, and the timer that ends
 * the turn once they are all answered and it has gone quiet */
interface OwnTurn {
  open: Set<string>;
  settle: ReturnType<typeof setTimeout> | null;
}

/** the adapter process, initialized: enough to log in and to ask side questions */
interface Conn {
  link: AcpLink;
  ctx: acp.ClientContext;
  spec: AgentSpec;
  bounds: Bounds;
  authMethods: acp.AuthMethod[];
  /** session/resume: the agent can pick its own session back up without replaying it. The
   * transcript on disk is what the chat is drawn from, so a replay (session/load) has nothing to
   * tell this side and is never asked for: every replayed chunk would have to be told apart from
   * live output, and the SDK hands a notification over in more ticks than a response, so the tail
   * of a replay can land after the request that carried it has resolved. */
  resumeSession: boolean;
  closeSupported: boolean;
  /** session/delete: a side session is removed once its answer is in */
  deleteSupported: boolean;
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
  /** the mode ids the agent advertised for this session; null when it has no modes */
  modeIds: string[] | null;
  /** the agent's current mode as last told to us (set_mode, or its own current_mode_update) */
  modeId: string | null;
  /** the config option the modes live in, for an agent that offers them as one (OpenCode's `mode`)
   * rather than as ACP's `modes`; null when they are ACP modes or absent */
  modeConfigId: string | null;
  /** the select options toyon drives (model, effort), those the agent has, each with its
   * choices and the current value as last told to us */
  options: LiveOptions;
}

/** the attachments written and the bubble emitted: what a message needs before it can go out on
 * any path. Held on the item so a message that changes path — steered at a turn that settled first,
 * or sent again after a login — is recorded once and keeps the attachment numbers it was shown with. */
interface Recorded {
  attachments: Stored[];
}

interface QueueItem {
  text: string;
  context?: string[];
  attachments?: AttachmentInput[];
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
  /** messages steered into the running turn that the agent has not started answering. A cancel
   * takes such a message with the turn (the adapter never runs it), so a stop hands it back. */
  private steered: QueueItem[] = [];
  /** the message refused for want of credentials; sent again after a login */
  private refused: QueueItem | null = null;
  private running = false;
  private interrupted = false;
  private stopped = false;
  private conn: Conn | null = null;
  /** the spawn in flight, shared by whoever asks for the connection meanwhile */
  private connecting: Promise<Conn> | null = null;
  private live: Live | null = null;
  private reaper: ReturnType<typeof setTimeout> | null = null;
  /** The turn the agent is on with no prompt out, or null. Claude Code runs a background command
   * past the end of the turn that started it and prompts itself when the command exits, so its
   * work then arrives as updates alone; without this the worktree reads idle while it edits. */
  private own: OwnTurn | null = null;
  /** questions in flight on side sessions; the reaper waits for them */
  private asking = 0;
  /** ask cards waiting on a person, by ask id. The agent's request stays open on the wire until
   * one of these settles, and that is what blocks its turn. */
  private asks = new Map<string, PendingAsk>();
  private log: Transcript;
  /** the number the next attachment of each kind takes in this worktree's session; continues across
   * daemon restarts because the transcript remembers every attachment sent */
  private seq: Record<AttachmentKind, number>;
  /** the live session's advertised commands. Deliberately not a transcript event: the list is
   * the live session's state, not history, and an old list would be replayed as if current. An
   * instance field survives the adapter reap, which is the point; it starts empty again after a
   * daemon restart. */
  private commandList: AgentCommand[] = [];

  constructor(private d: AcpSessionDeps) {
    // the real list only arrives once the adapter is up, which is this worktree's first prompt.
    // Until then the last one this agent gave for this repo is a far better answer than nothing.
    this.commandList = d.seedCommands?.() ?? [];
    this.log = new Transcript(transcriptPathFor(d.transcriptsDir, d.worktreeId), d.worktreeId);
    this.seq = nextNumbers(
      this.log.entries.map(({ event }) => (event.type === "user-message" ? event.attachments : undefined)),
    );
    // a card the daemon died under: the adapter process went with it, so nothing is listening for
    // an answer. Close it here rather than let the next backfill draw a live-looking question that
    // can never be answered. Idempotent, since these end events close the set on the next boot.
    const open = new Set<string>();
    for (const { event } of this.log.entries) {
      if (event.type === "agent-question" || event.type === "agent-permission") open.add(event.id);
      else if (event.type === "agent-ask-end") open.delete(event.id);
    }
    for (const id of open) this.emit({ type: "agent-ask-end", id, outcome: "expired", ts: Date.now() });
  }

  get commands(): AgentCommand[] {
    return this.commandList;
  }
  onCommandsChange: ((commands: AgentCommand[]) => void) | null = null;

  /** Start the session early, purely so the `/` menu has a list before the first prompt (see
   * `commandList`); the answer is cached per agent and repo, so this runs about once per repo.
   * Best effort: an agent that will not start leaves the menu saying so, and the person finds out
   * properly when they send something. */
  async warmCommands(): Promise<void> {
    if (this.commandList.length > 0 || this.stopped) return;
    await this.warm();
  }

  /** Start the session now, so the first message meets a process that is up: the plus warms its
   * agent on the first keystroke, seconds before enter. Best effort, like the commands warm-up;
   * a failure is the send's to report properly. */
  async warm(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.ensureLive();
      // nothing is running, so let the idle reaper take the process back on its usual schedule
      this.maybeArmReaper();
    } catch (e) {
      log.debug(this.d.worktreeId, `agent warm-up skipped: ${this.describe(e)}`);
    }
  }

  get runningAgent(): string | null {
    return this.conn?.spec.id ?? null;
  }

  /** the process goes and the next message spawns whatever the record names now: a spare warmed
   * under the default agent, claimed for a task that asked for another */
  async restart(): Promise<void> {
    this.clearReaper();
    await this.dropConn();
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

  get unsettled(): boolean {
    return this.queue.length > 0 || this.steered.length > 0 || this.refused !== null || this.asks.size > 0;
  }

  get queueItems(): string[] {
    return this.waiting().map((q) => q.text);
  }

  /** what waits with no bubble of its own yet. A message already in the transcript (steered, then
   * handed back by a stop or by the agent) just goes next: drawn as queued it would show twice, and
   * taking it back to edit would send a second copy. */
  private waiting(): QueueItem[] {
    return this.queue.filter((q) => !q.recorded);
  }

  onQueueChange: (() => void) | null = null;

  private queueChanged() {
    this.onQueueChange?.();
  }

  unqueue(index: number) {
    const item = this.waiting()[index];
    if (!item) return;
    this.queue.splice(this.queue.indexOf(item), 1);
    this.queueChanged();
  }

  transcript(): TranscriptEntry[] {
    return this.log.entries;
  }

  note(event: AgentEvent) {
    this.emit(event);
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
    const { context, attachments } = opts;
    const item: QueueItem = { text, context, ...(attachments?.length ? { attachments } : {}) };
    // sending during a turn means "while you are doing that": an agent that takes steering reads the
    // message as part of the work it is already on, which is the whole reason a person types then.
    // A stop already on its way is the exception — that turn is going away, so the message waits.
    if ((this.running || this.own) && !this.interrupted && this.live?.conn.steering) {
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
    if (!live || !(this.running || this.own) || this.interrupted) return this.enqueue(item);
    // unanswered from the moment it goes out: a stop can land before the agent replies
    this.steered.push(item);
    let outcome: SteerOutcome;
    try {
      outcome = steerOutcome(
        await live.conn.ctx.request(STEER_METHOD, {
          sessionId: live.sessionId,
          prompt: buildPrompt(
            item.text,
            this.contextFor(item),
            undefined,
            this.carried(live, item.recorded.attachments),
          ),
          // the turn can also end on the wire: ask for the message back rather than let the agent
          // prompt itself with it, since nothing here would be tracking a turn it started alone
          _meta: { steering: { idleBehavior: "promptRequired" } },
        }),
      );
    } catch (e) {
      // nothing was injected: both adapters validate the request before they push anything
      log.warn(this.d.worktreeId, "steering failed; the message goes as its own turn", e);
      if (this.unsteer(item)) this.enqueue(item);
      return;
    }
    // a stop that landed while the request was out has already queued it
    if (outcome === "promptRequired") {
      if (this.unsteer(item)) this.enqueue(item);
      return;
    }
    if (outcome === "startedNewTurn") {
      // an agent that ignored the opt-in and prompted itself. Sending it again would run the same
      // message twice and cancelling could take the new turn with it, so the agent keeps it: its
      // updates open a turn of the agent's own. Hold the reaper off until they do. That includes
      // a copy a stop already queued.
      if (!this.unsteer(item)) {
        this.queue = this.queue.filter((q) => q !== item);
        this.queueChanged();
      }
      this.clearReaper();
      log.warn(this.d.worktreeId, "steered message started a turn of the agent's own");
    }
  }

  /** off the unanswered list; false when a stop has already moved it to the queue */
  private unsteer(item: QueueItem): boolean {
    const at = this.steered.indexOf(item);
    if (at >= 0) this.steered.splice(at, 1);
    return at >= 0;
  }

  /** Interrupt the running turn. Context up to the interrupt persists in the agent's session, and
   * anything queued goes next from there: a stop is for the turn, not for the messages behind it. */
  stop() {
    // before the running guard and before session/cancel: an open card is the thing holding the
    // turn open, so the agent unblocks on our answer whether or not its own cancel reaches it
    this.cancelAsks();
    if (!this.running) {
      // a turn of the agent's own has no prompt to fail: the cancel goes out and the turn ends here
      if (this.own && this.live) {
        const { conn, sessionId } = this.live;
        fireAndForget(this.d.worktreeId, conn.ctx.notify(acp.methods.agent.session.cancel, { sessionId }), "cancel");
        this.endOwn("interrupted");
      }
      return;
    }
    this.interrupted = true;
    // what the agent had not got to goes first, ahead of anything sent after it
    if (this.steered.length > 0) {
      this.queue.unshift(...this.steered);
      this.steered = [];
      this.queueChanged();
    }
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
    // nothing may start a turn after this, so what was queued goes with the process
    this.queue = [];
    this.steered = [];
    this.queueChanged();
    this.stop();
    await this.dropConn();
    await this.log.flush();
  }

  private async drain() {
    // the prompt going out is the next turn, so the one the agent was on alone is over
    this.endOwn("end_turn");
    this.running = true;
    this.clearReaper();
    this.setStatus("working");
    let item: QueueItem | null = null;
    try {
      while (this.queue.length > 0) {
        item = this.queue.shift()!;
        this.queueChanged();
        try {
          await this.runTurn(item);
        } catch (e) {
          if (!this.interrupted) throw e;
          this.emit({ type: "turn-end", stopReason: "interrupted", ts: Date.now() });
        }
        // the stop was for that turn: what was queued behind it, or sent while its cancel settled,
        // goes next without the status dropping to idle in between
        this.interrupted = false;
        this.steered = [];
      }
      this.setStatus("idle");
    } catch (e) {
      if (this.conn && (isAuthRequired(e) || this.rejectedCredential(e))) {
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
      this.steered = [];
      this.running = false;
      this.maybeArmReaper();
    }
  }

  async ask(system: string, prompt: string, opts: AskOpts = {}): Promise<string | null> {
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
        ...(opts.quick ? { quick: opts.quick } : {}),
        route: (id, onText) => {
          conn.side.set(id, onText);
          return () => {
            conn.side.delete(id);
            // the command list it pushed at birth goes with it
            conn.commands.delete(id);
          };
        },
        caps: { close: conn.closeSupported, delete: conn.deleteSupported },
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
    const login = terminalLogin(method);
    if (login) {
      const l = this.d.launch(conn.spec);
      const instead = conn.spec.terminalLogins?.[methodId];
      // ACP's terminal method adds arguments to the adapter's own command line. A terminal-auth
      // `_meta` names a command of its own (OpenCode's `opencode auth login`), which is the agent
      // binary this toyon installed, without the arguments that start it as an adapter. A spec's
      // own replacement follows the adapter's command line, as ACP's does.
      const head = login.own && !instead ? l.args.slice(0, l.args.length - (conn.spec.run.args?.length ?? 0)) : l.args;
      return {
        kind: "terminal",
        run: {
          command: l.command,
          args: [...head, ...(instead?.args ?? login.args)],
          env: { ...conn.spec.env, ...instead?.env },
        },
      };
    }
    try {
      await conn.ctx.request(acp.methods.agent.authenticate, {
        methodId,
        ...(apiKey ? { _meta: { "api-key": { apiKey } } } : {}),
      });
    } catch (e) {
      throw new UserError(`${conn.spec.name} login failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.loggedIn();
    return { kind: "done" };
  }

  loggedIn() {
    this.emit({ type: "agent-auth-ok", ts: Date.now() });
    this.retry();
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
    // JSON-RPC's name for the error code, which the adapter puts in front of the provider's own words
    const message = (e instanceof Error ? e.message : String(e)).replace(/^Internal error: /, "");
    // the SDK's generic close message; the process's own exit is the useful part
    return /connection closed/i.test(message) ? (this.conn?.link.exitInfo() ?? message) : message;
  }

  /** write the attachments and show the message. Numbered and written in the order they were
   * attached before anything is shown, so the bubble and the prompt agree on "Image N". */
  private async record({ text, attachments }: QueueItem): Promise<Recorded> {
    const stored: Stored[] = [];
    for (const a of attachments ?? [])
      stored.push(await this.d.attachments.put(this.d.worktreeId, this.seq[a.kind]++, a));
    this.emit({
      type: "user-message",
      text,
      ts: Date.now(),
      ...(stored.length ? { attachments: stored.map((s) => s.ref) } : {}),
    });
    return { attachments: stored };
  }

  /** the attachments this connection will take, and the visible note when it will not take the
   * images among them */
  private carried(live: Live, stored: Stored[]): Stored[] {
    const images = live.conn.acceptsImages ? 0 : stored.filter((s) => s.ref.kind === "image").length;
    if (!images) return stored;
    // visible rather than silent: the rest still goes, the person sees why the image did not
    this.emit({
      type: "agent-error",
      message: `${live.conn.spec.name} does not accept images; the message went without ${images === 1 ? "it" : "them"}`,
      ts: Date.now(),
    });
    return stored.filter((s) => s.ref.kind !== "image");
  }

  private async runTurn(item: QueueItem) {
    item.recorded ??= await this.record(item);
    this.emit({ type: "turn-start", ts: Date.now() });
    const live = await this.ensureLive();
    await this.applyMode(live);
    await this.applyOption(live, "model");
    await this.applyOption(live, "thought_level");
    // a stop that landed while the agent was starting or being set up had no turn to cancel, so the
    // prompt must not go out at all: esc straight after a send would otherwise do nothing. Nothing
    // runs between this check and the request being written, so a later stop's cancel follows it.
    if (this.interrupted) {
      this.emit({ type: "turn-end", stopReason: "interrupted", ts: Date.now() });
      return;
    }
    const carried = this.carried(live, item.recorded.attachments);
    const prefix = live.prefixPending ? SYSTEM_APPEND : undefined;
    live.prefixPending = false;
    const res = await live.conn.ctx.request(acp.methods.agent.session.prompt, {
      sessionId: live.sessionId,
      prompt: buildPrompt(item.text, this.contextFor(item), prefix, carried),
    });
    this.emit({ type: "turn-end", stopReason: mapStopReason(res.stopReason), ts: Date.now() });
  }

  /** what the shell attached when the message was sent, then where the preview stands now that
   * it is going out, wrapped as one block */
  private contextFor(item: QueueItem): string | undefined {
    return ambientBlock([...(item.context ?? []), this.d.preview?.()]);
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
    const prepared = await (this.d.prepare ?? prepareLaunch)(this.d.cwd, spec);
    const { bounds } = prepared;
    const sandboxed = spec.confinement !== "none";
    const side = new Map<string, (text: string) => void>();
    const commands = new Map<string, AgentCommand[]>();
    const app = acp
      .client({ name: "toyon" })
      .onRequest(acp.methods.client.session.requestPermission, (c) => this.onPermission(c.params, bounds, sandboxed))
      .onRequest(acp.methods.client.elicitation.create, (c) => this.onElicit(c.params, c.signal))
      .onNotification(acp.methods.client.session.update, (c) => this.onUpdate(c.params, side, commands))
      // the agent pushes its identity unasked, here and whenever it changes; settings shows the last one
      .onNotification(AUTH_STATUS_UPDATE_METHOD, parseAuthStatus, (c) => {
        if (c.params) this.d.onAuth?.(spec.id, { status: c.params });
      });
    const link = this.d.connect(app, spec, prepared);
    const ctx = link.conn.agent;
    // the process dying while idle must not leave a dead handle for the next prompt to use
    link.exited.then(() => {
      if (this.conn?.link === link) {
        log.warn(this.d.worktreeId, "agent process exited while idle");
        this.conn = null;
        this.live = null;
        this.cancelAsks();
        this.endOwn("interrupted");
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
          // an agent offers its terminal login only to a client that says it can run one; toyon's
          // terminal pane can (OpenCode's `opencode auth login`)
          _meta: { "terminal-auth": true },
        },
        clientInfo: { name: "toyon", version: "0" },
      });
      this.conn = {
        link,
        ctx,
        spec,
        bounds,
        authMethods: init.authMethods ?? [],
        resumeSession: !!init.agentCapabilities?.sessionCapabilities?.resume,
        closeSupported: !!init.agentCapabilities?.sessionCapabilities?.close,
        deleteSupported: !!init.agentCapabilities?.sessionCapabilities?.delete,
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
    if (sessionId && conn.resumeSession) {
      try {
        const r = await conn.ctx.request(acp.methods.agent.session.resume, {
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
    const options = readOptions(configOptions);
    this.emit({ type: "session-info", sessionId: sessionId!, ...currentValues(options) });
    this.learn(options);
    const modeOption = modes ? null : readModeOption(configOptions);
    this.live = {
      conn,
      sessionId: sessionId!,
      prefixPending: !resumed && conn.spec.systemPrompt === "prompt-prefix",
      tools: new Map(),
      modeIds: modes ? modes.availableModes.map((m) => m.id) : (modeOption?.ids ?? null),
      modeId: modes?.currentModeId ?? modeOption?.current ?? null,
      modeConfigId: modeOption?.id ?? null,
      options,
    };
    // the worktree's mode, model and effort, applied now so a resumed session does not answer its
    // first prompt with whatever the agent remembered. Effort last: its choices depend on the model
    await this.applyMode(this.live);
    await this.applyOption(this.live, "model");
    await this.applyOption(this.live, "thought_level");
    // the push that landed while session/new was in flight, now that the id is known. Only when
    // there is one: an agent that does not re-push on resume keeps the list it already had.
    const pushed = conn.commands.get(sessionId!);
    if (pushed) this.setCommands(pushed);
    return this.live;
  }

  /** the worktree's mode is the record's, read fresh: a switch in the composer between two
   * turns, or a plan approval, must hold for the next prompt without a restart */
  private mode(): PermissionMode {
    return this.d.mode?.() ?? DEFAULT_PERMISSION_MODE;
  }

  /** put the agent in the session mode that toyon's mode maps to, when it differs and the agent
   * has one. An agent with no fitting mode (no read-only mode for `plan`) just runs, and the policy
   * still holds every write for a person, so plan degrades to ask rather than to auto. */
  private async applyMode(live: Live): Promise<void> {
    if (!live.modeIds) return;
    const wanted = agentModeFor(live.conn.spec, this.mode(), live.modeIds);
    if (!wanted || wanted === live.modeId) return;
    if (live.modeConfigId) {
      const r = await live.conn.ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: live.sessionId,
        configId: live.modeConfigId,
        value: wanted,
      });
      this.absorb(live, r.configOptions);
    } else {
      await live.conn.ctx.request(acp.methods.agent.session.setMode, { sessionId: live.sessionId, modeId: wanted });
    }
    live.modeId = wanted;
  }

  /** ask for the worktree's value in a category when it names one the agent offers and is not
   * already on. The agent's reply carries every option afresh (a model switch can take the effort
   * list with it), so the whole set is re-read from it, and the transcript gets the session-info
   * that says what it settled on. A value the current list lacks is left alone at debug level: a
   * worktree stamped with an effort its model has since lost is an ordinary state, not a fault. */
  private async applyOption(live: Live, category: OptionCategory): Promise<void> {
    const opt = live.options.get(category);
    const wanted = this.d.option?.(category);
    if (!opt || !wanted || wanted === opt.current) return;
    if (!opt.ids.includes(wanted)) {
      log.debug(this.d.worktreeId, `acp: ${category} ${wanted} is not offered; left on ${opt.current}`);
      return;
    }
    const r = await live.conn.ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: live.sessionId,
      configId: opt.id,
      value: wanted,
    });
    this.absorb(live, r.configOptions);
    this.emit({ type: "session-info", sessionId: live.sessionId, ...currentValues(live.options) });
  }

  /** the agent's full option list, as its reply or its own update carries it: a category missing
   * from it has gone away (effort, after a switch to a model without one) */
  private absorb(live: Live, configOptions: acp.SessionConfigOption[] | null | undefined) {
    live.options = readOptions(configOptions);
    this.learn(live.options);
    // the agent's mode rides in the same list when it offers modes as an option
    const modes = live.modeConfigId ? readModeOption(configOptions) : null;
    if (modes) {
      live.modeIds = modes.ids;
      live.modeId = modes.current;
    }
  }

  private learn(options: LiveOptions) {
    for (const [category, opt] of options) this.d.onOptionsLearned?.(category, opt.choices);
  }

  private onUpdate(
    params: acp.SessionNotification,
    side: Map<string, (text: string) => void>,
    commands: Map<string, AgentCommand[]>,
  ) {
    // ahead of the session guard below: the list arrives before session/new resolves (so `live` is
    // still null). Buffered rather than published, because an ask session's list lands before
    // askOnce has registered its id in `side` and must not win over the worktree's own.
    if (params.update.sessionUpdate === "available_commands_update") {
      const mapped = mapCommands(params.update.availableCommands);
      commands.set(params.sessionId, mapped);
      if (this.live && params.sessionId === this.live.sessionId) this.setCommands(mapped);
      return;
    }
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
    // the agent left plan mode on its own (an approved ExitPlanMode does): remember, so the next
    // turn's applyMode compares against what it is in, not what we last asked for
    if (params.update.sessionUpdate === "current_mode_update") {
      live.modeId = params.update.currentModeId;
      return;
    }
    // the agent changed its own model or effort (a slash command can): keep the comparison honest
    if (params.update.sessionUpdate === "config_option_update") this.absorb(live, params.update.configOptions);
    const events = mapUpdate(params.update, live.tools, this.d.worktreeId);
    if (!this.running) this.trackOwn(events);
    for (const ev of events) {
      // words or a call after a steer are the agent answering it. Output the pre-emption cut off can
      // still trail in and clear this early, and a stop then takes that message with the turn.
      if (ev.type === "text-delta" || ev.type === "tool-start") this.steered = [];
      // the mapper does not know the session id; the transcript wants the real one
      this.emit(ev.type === "session-info" ? { ...ev, sessionId: live.sessionId } : ev);
    }
  }

  private onPermission(
    params: acp.RequestPermissionRequest,
    bounds: Bounds,
    sandboxed: boolean,
  ): Promise<acp.RequestPermissionResponse> {
    // taken now: a card the process took down with it settles after `live` is already gone
    const tools = this.live?.tools;
    return Promise.resolve(this.answerPermission(params, bounds, sandboxed)).then((res) => {
      const end = tools && endOfAsk(params, res, tools);
      if (end) this.emit(end);
      return res;
    });
  }

  private answerPermission(
    params: acp.RequestPermissionRequest,
    bounds: Bounds,
    sandboxed: boolean,
  ): acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse> {
    // a side session shares this connection but has no chat: its requests are never a card or a
    // blocked row in the worktree's transcript, the same way its elicitations are declined
    const live = this.live;
    if (!live || params.sessionId !== live.sessionId) return decideUnattended(params, bounds, this.d.cwd);
    const verdict = decide(params, bounds, this.d.cwd, this.mode(), sandboxed);
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
  private async askPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const plan = params.toolCall.kind === "switch_mode";
    const detail = permissionDetail(params);
    // the document is written before the card goes out, so the card names a file that is already
    // there to open; a worktree that would not take it leaves the plan on the card
    const planPath = plan ? ((await this.d.onPlan?.(detail)) ?? null) : null;
    // a plan's options are all one-time answers. An edit's or a command's include the agent's
    // "always allow", which would write a rule into its settings and take every later request of
    // that shape away from this policy; the card offers only what keeps the mode meaning something
    const offered = plan ? params.options : params.options.filter((o) => o.kind !== "allow_always");
    const choices: AskChoice[] = offered.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }));
    return this.openAsk<acp.RequestPermissionResponse>(
      (id) => ({
        type: "agent-permission",
        id,
        title: params.toolCall.title ?? params.toolCall.name ?? "the agent needs a decision",
        ...(detail ? { detail } : {}),
        ...(planPath ? { plan: planPath } : {}),
        choices,
        ...(params.toolCall.toolCallId ? { toolId: params.toolCall.toolCallId } : {}),
        ts: Date.now(),
      }),
      (_outcome, reply) => {
        const picked = reply?.kind === "choice" ? reply.choiceId : undefined;
        const choice = picked ? choices.find((c) => c.id === picked) : undefined;
        if (!choice) return { outcome: { outcome: "cancelled" } };
        // approving a plan is also choosing how the work after it runs: Claude's options say
        // whether edits are auto-accepted or approved one by one, and the worktree's mode follows
        if (plan && (choice.kind === "allow_once" || choice.kind === "allow_always")) {
          this.d.setMode?.(modeAfterPlan(choice.name));
          // the yes said yes to the file, which may no longer be the plan the agent holds
          if (planPath) fireAndForget(this.d.worktreeId, this.sayPlanEdited(detail, planPath), "edited plan");
        }
        return { outcome: { outcome: "selected", optionId: choice.id } };
      },
    );
  }

  /** A plan approved after it was rewritten. A permission answer is an option id and nothing else,
   * so the agent would go and build the version it proposed; the file it must work from goes in as
   * a message instead, which steers into the turn the approval just released. */
  private async sayPlanEdited(proposed: string, path: string) {
    if (!(await this.d.planEdited?.(path, proposed))) return;
    this.send(`I edited the plan before approving it. Build what is in ${path}, not the plan you proposed.`);
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
      log.warn(this.d.worktreeId, `elicitation Toyon cannot draw as choices; declined: ${params.message}`);
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
    this.setStatus(this.asks.size > 0 ? "waiting" : this.running || this.own ? "working" : "idle");
  }

  /** Updates with no prompt out are the agent working on its own. The first word or call opens a
   * turn in the transcript so the shell reads it as one; it ends once every call it made has been
   * answered and it has been quiet for a while, since nothing on the wire says it is done. */
  private trackOwn(events: AgentEvent[]) {
    if (!this.own) {
      const doing = events.some(
        (e) => e.type === "text-delta" || e.type === "thinking-delta" || e.type === "tool-start",
      );
      if (!doing) return;
      this.own = { open: new Set(), settle: null };
      this.clearReaper();
      this.emit({ type: "turn-start", ts: Date.now() });
      this.syncStatus();
    }
    for (const e of events) {
      if (e.type === "tool-start") this.own.open.add(e.toolId);
      else if (e.type === "tool-end") this.own.open.delete(e.toolId);
    }
    if (this.own.settle) clearTimeout(this.own.settle);
    this.own.settle = null;
    if (this.own.open.size > 0) return;
    const t = setTimeout(() => this.endOwn("end_turn"), this.d.ownSettleMs ?? OWN_SETTLE_MS);
    t.unref?.();
    this.own.settle = t;
  }

  private endOwn(stopReason: string) {
    if (!this.own) return;
    if (this.own.settle) clearTimeout(this.own.settle);
    this.own = null;
    this.emit({ type: "turn-end", stopReason, ts: Date.now() });
    this.syncStatus();
    this.maybeArmReaper();
  }

  private maybeArmReaper() {
    if (!this.running && !this.own && !this.asking && this.asks.size === 0 && this.conn && !this.stopped)
      this.armReaper();
  }

  private armReaper() {
    this.clearReaper();
    const t = setTimeout(() => {
      this.reaper = null;
      if (this.running || this.own || this.asking || this.asks.size > 0 || !this.conn) return;
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

/** how many lines of a proposed file the card shows before it cuts */
const DETAIL_LINES = 80;

/** What the card shows under its title: a plan's markdown, an edit's diff, a command's line. The
 * two agents put the plan in different places (Claude's ExitPlanMode renders it as a text content
 * block, Codex's plan review sends only rawInput.plan), and an edit arrives as a diff block whose
 * new text is what a person has to read to say yes. */
export function permissionDetail(params: acp.RequestPermissionRequest): string {
  const parts: string[] = [];
  for (const c of params.toolCall.content ?? []) {
    if (c.type === "content" && c.content.type === "text") parts.push(c.content.text);
    else if (c.type === "diff") {
      const lines = c.newText.split("\n");
      const shown = lines.slice(0, DETAIL_LINES).join("\n");
      const more = lines.length > DETAIL_LINES ? `\n… ${lines.length - DETAIL_LINES} more lines` : "";
      parts.push(`\`${c.path}\`\n\n\`\`\`\n${shown}${more}\n\`\`\``);
    }
  }
  if (parts.length > 0) return parts.join("\n\n");
  const raw = params.toolCall.rawInput as { plan?: unknown; command?: unknown } | undefined;
  if (typeof raw?.plan === "string") return raw.plan;
  if (typeof raw?.command === "string") return `\`\`\`sh\n${raw.command}\n\`\`\``;
  return "";
}

/** ACP's auth_required code means "no credential"; a credential the provider rejected has no code
 * of its own and arrives as the failed turn's text, so the provider's wording is all there is to
 * read. Kept to phrasings that can only be about credentials — a 403 is usually about permission
 * or quota, and asking someone to log in again would not help. */
const REJECTED_CREDENTIAL_RE =
  /\b401\b|unauthorized|invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?(error|failed)|api key (is )?(invalid|expired|incorrect)|incorrect api key|(token|credential)s? (have |has )?expired|expired (token|credential)|not (logged in|authenticated)/i;

/** a login method that runs in a terminal: ACP's terminal type, whose args follow the adapter's own
 * command, or a terminal-auth `_meta`, whose args follow the agent binary alone */
function terminalLogin(m: acp.AuthMethod): { own: boolean; args: string[] } | null {
  if ("type" in m && m.type === "terminal") return { own: false, args: m.args ?? [] };
  const meta = (m._meta as Record<string, unknown> | null | undefined)?.["terminal-auth"];
  if (!meta || typeof meta !== "object") return null;
  const args = (meta as { args?: unknown }).args;
  return { own: true, args: Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [] };
}

function authMethodInfo(m: acp.AuthMethod): AuthMethodInfo {
  const terminal = terminalLogin(m) !== null;
  return {
    id: m.id,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    kind: terminal ? "terminal" : "agent",
    ...(!terminal && /api[-_ ]?key/i.test(`${m.id} ${m.name}`) ? { needsKey: true } : {}),
  };
}

function sameCommands(a: AgentCommand[], b: AgentCommand[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.name === b[i]?.name && c.description === b[i]?.description && c.hint === b[i]?.hint)
  );
}
