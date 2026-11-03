// One agent session per worktree over ACP. The adapter process is spawned on the first prompt and
// reaped a few minutes after the last turn ends, so idle worktrees cost nothing; the next prompt
// respawns it and picks the agent's own session back up (session/resume) when the agent supports
// that. The transcript JSONL is the source of truth for rendering; the agent's session id only
// serves resume, and the agent is never asked to replay its history. Two layers on purpose: a Conn (process + initialize) that logging in and side questions
// need, and a Live session on top of it that the chat turns use.

import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type {
  AgentCommand,
  AgentEvent,
  AgentLimits,
  AgentStatus,
  AskAnswer,
  AskChoice,
  Asked,
  AskOutcome,
  AttachmentInput,
  AttachmentKind,
  AuthMethodInfo,
  CommandOrigin,
  ModelChoice,
  PermissionMode,
  Piece,
  QueuedMessage,
} from "@toyon/shared";
import { DEFAULT_PERMISSION_MODE, nextNumbers, relistChoice } from "@toyon/shared";
import { UserError } from "../../core/errors.ts";
import { fireAndForget, log } from "../../core/log.ts";
import type { AgentAdapter, AskOpts, AskReply, AuthOutcome, FollowUp, Handed, SendOpts } from "../adapter.ts";
import type { AttachmentStore, Stored } from "../attachments.ts";
import {
  AWS_EXPIRED_RE,
  AWS_LOGIN_METHOD,
  AWS_REFRESH_METHOD,
  type AwsAuth,
  awsLoginCommand,
  awsMethods,
  readAwsAuth,
  setAwsAuthRefresh,
} from "../awsAuth.ts";
import { agentModeFor, modeAfterPlan, orderPlanOptions } from "../modes.ts";
import { markOrigins } from "../origins.ts";
import { formatOutput } from "../output.ts";
import { adoptPicture, PICTURES_MAX, pictureLinks } from "../pictures.ts";
import { decide, decideUnattended, pickOption } from "../policy.ts";
import { ambientBlock, buildPrompt, pieceLandedContext, SYSTEM_APPEND } from "../prompt.ts";
import type { AgentSpec } from "../registry.ts";
import { type Bounds, type Prepared, prepareLaunch } from "../sandbox.ts";
import { isMessage, sealOpenTurn, Transcript, type TranscriptEntry, transcriptPathFor } from "../transcript.ts";
import { uploadIds } from "../uploads.ts";
import { askOnce } from "./ask.ts";
import {
  AUTH_STATUS_UPDATE_METHOD,
  type AuthObservation,
  isAuthRequired,
  parseAuthStatus,
  supportsLogout,
} from "./authstatus.ts";
import { BackgroundTasks, claudeConfigDir } from "./background.ts";
import { parseForm, toContent } from "./elicit.ts";
import { endOfAsk, mapCommands, mapStopReason, mapUpdate, preempted, release, type ToolMemos } from "./map.ts";
import {
  currentName,
  currentValues,
  type LiveOptions,
  type OptionCategory,
  readModeOption,
  readOptions,
} from "./options.ts";
import { parseRateLimit } from "./ratelimit.ts";
import { STEER_METHOD, type SteerOutcome, steerOutcome, supportsSteering } from "./steering.ts";
import type { AcpLink } from "./transport.ts";
import { Wakeups } from "./wakeup.ts";
import { wireFlags } from "./wire.ts";

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
  /** whether a sign-in with a consumer plan may be offered: a managed policy says no on company
   * code, so the card leaves it out and a request for it is refused. Yes when absent. */
  planSignIn?: () => boolean;
  transcriptsDir: string;
  /** where attached images are written before the prompt carries them */
  attachments: AttachmentStore;
  getSessionId: () => string | undefined;
  setSessionId: (id: string) => void;
  onEvent: AgentEventListener;
  onStatus: AgentStatusListener;
  /** `stopping` moved: on at a stop press, off when the turn it was for has ended */
  onStopping?: () => void;
  /** `holding` moved: a row held open past the turn for something still going (a command sent
   * to the background, a wakeup booked) opened or closed */
  onHolding?: () => void;
  /** whatever this connection learns about the agent's credentials, for the per-agent cache */
  onAuth?: (agentId: string, o: AuthObservation) => void;
  /** how much of its plan the account has used, as a reply reported it: per agent, like the
   * credentials, since every worktree on the agent spends the same windows */
  onLimits?: (agentId: string, limits: AgentLimits) => void;
  /** what the `/` menu shows before this worktree's own agent has advertised anything */
  seedCommands?: () => AgentCommand[];
  /** the list this agent advertised, kept for the next worktree on the same repo */
  onCommandsLearned?: (commands: AgentCommand[]) => void;
  /** which names on that list the person wrote, by where the file sits (agent/origins.ts). Read
   * on every push, which is when a skill added to the folder shows up: the agent re-lists on its
   * own reload, and the folders are a handful of entries. */
  commandOrigins?: () => Map<string, CommandOrigin>;
  /** how long an idle adapter process lives after its last turn */
  idleMs?: number;
  /** how long a turn the agent started on its own may go quiet before it is over */
  ownSettleMs?: number;
  /** how long a call's input is held for the rest of it before it is read as whole */
  inputHoldMs?: number;
  /** where Claude Code keeps its session logs, for the end of a command sent to the background
   * (background.ts); its own default when absent */
  claudeConfigDir?: string;
  /** how often such a command's files are looked at */
  taskPollMs?: number;
  /** how long past a booked wakeup its row waits for the turn (tests shorten it) */
  wakeupGraceMs?: number;
  /** the worktree's bounds, after the agent's own setup has run (agent/sandbox.ts `prepareLaunch`) */
  prepare?: (cwd: string, spec: AgentSpec) => Promise<Prepared>;
  /** A message is about to go to the agent as a turn of its own. Awaited, so whatever is read here
   * is read before the agent can write: the tree the turn starts from. */
  beforeTurn?: () => Promise<void>;
  /** what the agent may do here without asking; read before every turn and every permission */
  mode?: () => PermissionMode;
  /** a plan approval decided the mode for the work that follows */
  setMode?: (mode: PermissionMode) => void;
  /** A plan card is about to be shown, whatever becomes of it. Takes the plan's markdown and the
   * file the agent says it planned in, when it keeps one, and answers with the worktree-relative
   * file the card should name: the agent's own, or the one the plan was written to, or null if
   * there is none. */
  onPlan?: (markdown: string, ownFile?: string) => Promise<string | null>;
  /** whether the plan file the card named says something other than what the agent proposed */
  planEdited?: (path: string, proposed: string) => Promise<boolean>;
  /** a pieces list held beside a plan card was answered with the plan: approved, or sent back */
  onHandoff?: (id: string, approved: boolean) => void;
  /** a plan card went up with no list handed over for it: takes the plan's markdown and its file,
   * for a list read off the plan by Toyon, which arrives held and rides the card like one the
   * agent handed over */
  onPlanUnsplit?: (markdown: string, planPath: string) => void;
  /** a held pieces list is Toyon's own card from here: its turn ended with no plan card, or the
   * daemon came back under it. Takes the pieces and answers with the worktree-relative file their
   * briefs were written to, for the card's section to sit on; nothing else, since this runs where
   * nothing can be awaited (the transcript restoring, a turn ending). */
  onHandoffShown?: (id: string, pieces: Piece[]) => string | null | undefined;
  /** the value the worktree asks for in this category (its model, its effort level); undefined
   * leaves the agent on its own default */
  option?: (category: OptionCategory) => string | undefined;
  /** what the agent advertised for the category when a session opened or the list changed, for
   * the picker. Only categories present are reported: an agent that has effort on some models
   * and not others keeps the last list it gave rather than flapping off. `runs` is the value a
   * fresh session opened on before toyon asked for anything: the agent's own default, which its
   * settings pick and its default row's words need not follow. Absent on a resumed session (that
   * value is the transcript's) and on a list re-read after a switch (that value is the switch). */
  onOptionsLearned?: (category: OptionCategory, choices: ModelChoice[], runs?: string) => void;
  /** the agent moved to another value in the category on its own (a slash command in the chat
   * does), or the record's value is one it will not take and the empty value, its own choice, is
   * what stands. The record is expected to follow: the next turn re-applies the record before
   * its prompt, so one that still named the old value would put it back. */
  onOptionChanged?: (category: OptionCategory, value: string) => void;
  /** the worktree's own title and branch, as a sentence after every message; read as each goes
   * out, since the agent names the row after its first turn and the person renames it at will */
  self?: () => string | undefined;
  /** where the worktree's work stands (the tree, the branch against its base, a landing, a PR),
   * as a paragraph after every message. Read as each goes out, and awaited, since the tree is
   * read for it: a commit from the box or a land a moment ago is what the agent must hear */
  standing?: () => Promise<string | undefined>;
  /** where the preview stands, as a block after every message; read as each goes out, since the
   * port belongs to the runtime and not to this session */
  preview?: () => string | undefined;
  /** what the preview's page has thrown since it last loaded, as a paragraph after every message,
   * read as each goes out: what the person's browser met is what the agent should hear */
  pageErrors?: () => string | undefined;
  /** the project's other worktrees the message names by branch, a paragraph each saying where
   * its chat is; read as the message goes out, so a row made since the session opened counts */
  mentioned?: (text: string) => string[];
  /** the adapter's process group came up (`true`, right after the spawn and before initialize,
   * so a daemon dying mid-start still has it on record) or went (`false`), for the ledger */
  onProcess?: (pgid: number, up: boolean) => void;
  /** Toyon's own tools for this worktree's agent, served over MCP: `open` mints the entry (and
   * the bearer in it) for a process that takes HTTP servers, `close` retires it with the process.
   * Absent where there is nothing to hand them to (tests, a probe). */
  mcp?: { open: () => acp.McpServer; close: () => void };
  /** what every agent is told about working in a Toyon worktree, in place of SYSTEM_APPEND: a
   * candidate wording under the handoff eval (acp/handoff.eval.test.ts). The daemon leaves it unset. */
  systemAppend?: () => string;
}

const DEFAULT_IDLE_MS = Number(process.env.TOYON_AGENT_IDLE_MS) || 5 * 60_000;
/** The quiet that ends a turn the agent started on its own. Between a tool's result and the next
 * call the wire carries nothing while the model reads the result, seconds on a long context; a
 * turn cut at that gap would come back as a second one, so the wait errs long. */
const OWN_SETTLE_MS = 10_000;
/** Long enough for the field after the one that closed to stream in, a command's description above
 * all, so a half-written input rarely reaches the row; short enough that a command already running
 * does not read as one still being written. */
const INPUT_HOLD_MS = 1000;

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
  /** Toyon's own MCP server for the worktree's session, when the agent takes HTTP servers;
   * empty otherwise. Side sessions never get it: no chat behind them, no card to raise. */
  mcpServers: acp.McpServer[];
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
  /** what Toyon's own message was sent for, when it is one: what rides behind it reads it */
  asked?: Asked["kind"];
  /** sent on another agent's behalf: the record the message makes is `handed`, not a bubble */
  handed?: Handed;
  /** steered, then handed back to the queue by a stop: the agent can still go on past the cancel
   * and pick the message up after all (a command still running holds the interrupt off, and the
   * adapter forces the turn closed only after a floor), and its answer then belongs to the
   * bubble already in the chat, so the copy leaves the queue rather than run again. Over once
   * that turn has ended: from then on the copy is an ordinary queued message, and a later turn's
   * stop says nothing about it. */
  handedBack?: boolean;
}

/** a waiting message as the shell draws it and as a box takes it back */
const queued = (q: QueueItem): QueuedMessage => ({
  text: q.text,
  ...(q.attachments ? { attachments: q.attachments } : {}),
});

/** what the end event keeps of the answer, so a reload can read the card back */
function recorded(reply?: AskReply): { answers?: AskAnswer[]; choiceId?: string } {
  if (reply?.kind === "choice") return { choiceId: reply.choiceId };
  return reply?.kind === "answers" && reply.answers ? { answers: reply.answers } : {};
}

/** one open ask card. `settle` is the only way out: it answers the agent's request, appends the
 * end event and forgets the card, and it is safe to call twice (the loser of a race does nothing).
 * `before` is what goes to the agent ahead of the answer on the wire (see `answer`). */
interface PendingAsk {
  settle: (outcome: AskOutcome, reply?: AskReply, before?: () => Promise<void>) => void;
  /** a question card's headers, what a message sent behind the answer names */
  headers?: string[];
}

export class AcpSession implements AgentAdapter {
  status: AgentStatus = "idle";
  private queue: QueueItem[] = [];
  /** messages steered into the running turn that the agent has not started answering. A cancel
   * takes such a message with the turn (the adapter never runs it), so a stop hands it back. */
  private steered: QueueItem[] = [];
  /** the message the agent was writing when the last steer went out, by the id its text carries.
   * A steer pre-empts that message, but its deltas already on the wire still trail in; text under
   * a newer id is the agent answering the steer, text under this one is the cut-off tail. */
  private steerMark: string | undefined;
  /** the id of the message whose text arrived last */
  private streamingId: string | undefined;
  /** the message refused for want of credentials; sent again after a login */
  private refused: QueueItem | null = null;
  /** The turn the drain loop is on, from the loop starting until it is done, a fresh record for
   * each message it takes; null while no loop runs, which is what `running` reads. `open` is the
   * transcript's bracket: a turn-start written and its turn-end not yet, which every exit closes
   * through endTurn. `stopping` is a stop pressed for this turn whose cancel has not come back:
   * nothing steers into a turn that is going away, the prompt does not go out if the press came
   * first, and the rows show the press as landed, since the status stays busy until the agent
   * has in fact stopped. */
  private turn: { open: boolean; stopping: boolean } | null = null;
  private stopped = false;
  /** landing ops out on the worktree: while any is, nothing starts a turn and nothing is steered
   * into one, and what is sent meanwhile waits in the queue. A count, since a sync that waited for
   * the turn holds the queue from the turn's end until its own op has taken the hold over. */
  private holds = 0;
  private get held(): boolean {
    return this.holds > 0;
  }
  private conn: Conn | null = null;
  /** the spawn in flight, shared by whoever asks for the connection meanwhile */
  private connecting: Promise<Conn> | null = null;
  private opening: { conn: Conn; live: Promise<Live> } | null = null;
  private live: Live | null = null;
  private reaper: ReturnType<typeof setTimeout> | null = null;
  /** The turn the agent is on with no prompt out, or null. Claude Code runs a background command
   * past the end of the turn that started it and prompts itself when the command exits, so its
   * work then arrives as updates alone; without this the worktree reads idle while it edits. */
  private own: OwnTurn | null = null;
  /** the commands the agent sent to the background and has not heard the end of: their rows are
   * open, and the process they run under stays up for them */
  private tasks: BackgroundTasks;
  private wakeups: Wakeups;
  /** questions in flight on side sessions; the reaper waits for them */
  private asking = 0;
  /** ask cards waiting on a person, by ask id. The agent's request stays open on the wire until
   * one of these settles, and that is what blocks its turn. */
  private asks = new Map<string, PendingAsk>();
  /** handoff cards waiting on a person, by proposal id. The tool answers the agent at
   * once (its client times a call out before a person would answer), so nothing on the wire holds
   * the turn; the open card is what the row reads `waiting` from. Seeded from the transcript and
   * kept by the events that open and close one, so it survives a restart. */
  private openCards = new Set<string>();
  /** a pieces list proposed in plan mode, waiting for the turn's plan card to carry it: answered
   * with the plan, or shown as Toyon's own card once the turn ends without one */
  private heldHandoff: string | null = null;
  /** the plan card a held list rode onto, while that card is open: a card that closes with no
   * answer gives the list back to `heldHandoff`, to be shown as Toyon's own */
  private adopted: { ask: string; handoff: string } | null = null;
  /** the turn's reply so far, scanned for the pictures it names (scanPictures), and the targets
   * already copied */
  private replyText = "";
  private pictured = new Set<string>();
  /** the plan card open right now, so a list held after it went up (read off the plan by Toyon,
   * or handed over late) is the card's to answer too */
  private openPlanAsk: string | null = null;
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
    this.tasks = new BackgroundTasks({
      note: (e) => this.emit(e),
      onEnd: () => this.holdingChanged(),
      ...(d.taskPollMs !== undefined ? { pollMs: d.taskPollMs } : {}),
      ...(d.claudeConfigDir !== undefined ? { configDir: d.claudeConfigDir } : {}),
    });
    this.wakeups = new Wakeups({
      note: (e) => this.emit(e),
      onChange: () => this.holdingChanged(),
      ...(d.wakeupGraceMs !== undefined ? { graceMs: d.wakeupGraceMs } : {}),
    });
    this.seq = nextNumbers(
      this.log.entries.map(({ event }) =>
        event.type === "user-message" || event.type === "handed" ? event.attachments : undefined,
      ),
    );
    // a turn the daemon died under has no end: read what it is owed before the rows below are
    // added (they would read as the turn doing more), and write it after them, as its last event
    const seal = sealOpenTurn(this.log.entries);
    // a card the daemon died under: the adapter process went with it, so nothing is listening for
    // an answer. Close it here rather than let the next backfill draw a live-looking question that
    // can never be answered. Idempotent, since these end events close the set on the next boot.
    const open = new Set<string>();
    for (const { event } of this.log.entries) {
      if (event.type === "agent-question" || event.type === "agent-permission") open.add(event.id);
      else if (event.type === "agent-ask-end") open.delete(event.id);
    }
    for (const id of open) this.emit({ type: "agent-ask-end", id, outcome: "expired", ts: Date.now() });
    // a command's row held open for something running on (a `!` command's server, a command the
    // agent sent to the background): the process went with the daemon, and nothing is watching
    // the files any more. What it printed is on the row already; the end says why it stopped.
    const held = new Map<string, string>();
    for (const { event } of this.log.entries) {
      if (event.type === "tool-update" && event.background) held.set(event.toolId, "");
      else if (event.type === "tool-delta" && held.has(event.toolId))
        held.set(event.toolId, held.get(event.toolId) + event.text);
      else if (event.type === "tool-end") held.delete(event.toolId);
    }
    for (const [toolId, text] of held) {
      const output = [formatOutput(text, 0, false), "ended with the daemon that was watching it"].filter(Boolean);
      this.emit({ type: "tool-end", toolId, output: output.join("\n"), isError: true });
    }
    // a handoff card is answered through the daemon, not the agent's process, so one the daemon
    // died under is still open: the row reads waiting from it again. A go the daemon died under
    // is another matter: the worktrees it was making are not coming, so the list that stood for
    // them closes as failed rather than read "starting" for good.
    const going = new Set<string>();
    for (const { event } of this.log.entries) {
      this.trackCards(event);
      if (event.type === "handoff-go") going.add(event.id);
      else if (event.type === "handoff" || event.type === "handoff-declined") going.delete(event.id);
    }
    for (const id of going) {
      this.emit({
        type: "handoff-declined",
        id,
        outcome: "failed",
        reason: "Toyon stopped while the worktrees were being made",
        ts: Date.now(),
      });
    }
    if (seal) {
      log.info(d.worktreeId, `sealed a turn left open: ${seal.stopReason}`);
      this.emit(seal);
    }
    // a list held for a plan card the daemon died under stays held in plan mode, for the next
    // plan card; anywhere else it is Toyon's card from here
    this.showHeld();
    if (this.openCards.size > 0) this.syncStatus();
    this.restored = true;
  }

  /** the transcript is read and every card on it tracked: from here each event written tracks
   * itself as it is written */
  private restored = false;

  /** the open cards follow their events; true when the set changed. A pieces list proposed in
   * plan mode is held rather than open: the next plan card carries it, and its yes answers both. */
  private trackCards(event: AgentEvent): boolean {
    if (event.type === "handoff-proposed") {
      if (event.held) {
        this.heldHandoff = event.id;
        // held while a plan card is already up: that card answers it, and a card that closes
        // unanswered hands it back, as for a list the card went up with
        if (this.openPlanAsk) this.adopted = { ask: this.openPlanAsk, handoff: event.id };
        return false;
      }
      return this.openCards.add(event.id).size > 0;
    }
    if (event.type === "handoff-shown") {
      if (this.heldHandoff === event.id) this.heldHandoff = null;
      return this.openCards.add(event.id).size > 0;
    }
    if (event.type === "agent-permission") {
      if (event.plan) this.openPlanAsk = event.id;
      // the card carries the list: the list is the card's to answer, for as long as the card is
      if (event.handoff && this.heldHandoff === event.handoff) {
        this.heldHandoff = null;
        this.adopted = { ask: event.id, handoff: event.handoff };
      }
      return false;
    }
    if (event.type === "agent-ask-end") {
      if (this.openPlanAsk === event.id) this.openPlanAsk = null;
      if (this.adopted?.ask === event.id) {
        const handoff = this.adopted.handoff;
        this.adopted = null;
        // the card closed without an answer (the daemon died under it, the agent withdrew it,
        // the person stopped): the agent's list is held again and rides the next plan card, since
        // the list is the agent's word on the work and a card going away says nothing about it.
        // One Toyon read for the card goes with the card, since nobody asked for it apart from
        // the plan. An answer closes the list itself through `onHandoff`, so nothing to do here
        // for one.
        if (event.outcome !== "answered") {
          if (this.proposed(handoff)?.by === "toyon") {
            this.note({
              type: "handoff-declined",
              id: handoff,
              reason: "the plan card closed before it was answered",
              ts: Date.now(),
            });
          } else this.heldHandoff = handoff;
        }
      }
      return false;
    }
    if (event.type === "handoff-go" || event.type === "handoff" || event.type === "handoff-declined") {
      if (this.heldHandoff === event.id) this.heldHandoff = null;
      if (this.adopted?.handoff === event.id) this.adopted = null;
      return this.openCards.delete(event.id);
    }
    return false;
  }

  /** A held pieces list with no plan card to ride on becomes Toyon's own card, once the worktree
   * is out of plan mode: at the end of a turn, on a restart, or as the next message goes out
   * after the mode chip moved. In plan mode it stays held, since a plan card is still coming and
   * the list is that card's to answer; a card that went away unanswered hands it back here rather
   * than demote it. The page for the list is written first, so the event names the file the
   * card's section sits on. Once per list: a second call finds nothing held. */
  private showHeld(): void {
    const id = this.heldHandoff;
    if (!id || this.mode() === "plan") return;
    this.heldHandoff = null;
    this.openCards.add(id);
    const plan = this.d.onHandoffShown?.(id, this.proposed(id)?.pieces ?? []);
    this.emit({ type: "handoff-shown", id, ...(typeof plan === "string" ? { plan } : {}), ts: Date.now() });
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

  /** The record's mode changed under a session that is up: apply it now rather than at the next
   * prompt. A turn may be running; the composer chip is the person reaching into it (plan mode
   * flipped on while the agent is already working, then a message steered in to say so), and the
   * adapters set the mode on the live query. A session still opening applies the record itself
   * when it settles, and one not up at all is left alone: the next turn's applyMode covers it.
   * A refusal only logs; the mode is read again before every permission, so writes still hold. */
  modeChanged(): void {
    const live = this.live;
    if (!live || this.stopped) return;
    fireAndForget(this.d.worktreeId, this.applyMode(live), "mode change mid-session");
  }

  /** Start the session now, so the first message meets a process that is up: the plus warms its
   * agent on the first keystroke, seconds before enter. Best effort, like the commands warm-up;
   * a failure is the send's to report properly. */
  async warm(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.ensureLive("warm-up");
      // nothing is running, so let the idle reaper take the process back on its usual schedule
      this.maybeArmReaper();
    } catch (e) {
      log.debug(this.d.worktreeId, `agent warm-up skipped: ${this.describe(e)}`);
    }
  }

  get runningAgent(): string | null {
    return this.conn?.spec.id ?? null;
  }

  get mcpTools(): boolean | null {
    return this.conn ? this.conn.mcpServers.length > 0 : null;
  }

  /** set at the spawn rather than read off `conn`, which exists only once initialize has answered */
  private pgid_: number | null = null;
  get pgid(): number | null {
    return this.pgid_;
  }

  private noteProcess(link: AcpLink, up: boolean) {
    if (link.pid === null) return;
    if (up) this.pgid_ = link.pid;
    // keyed by the link's own pid: a replaced link's late exit must not clear the new one's record
    else if (this.pgid_ === link.pid) this.pgid_ = null;
    this.d.onProcess?.(link.pid, up);
  }

  /** the process goes and the next message spawns whatever the record names now: a spare warmed
   * under the default agent, claimed for a task that asked for another */
  async restart(): Promise<void> {
    this.clearReaper();
    await this.dropConn("restart");
  }

  /** the same path a restart takes under an open card, so the shell revives the question the same
   * way: expired, the turn stopped before the answer on the wire can start it again, the process
   * gone with the session id kept */
  async lapse(why: string): Promise<void> {
    this.clearReaper();
    this.cancelAsks("expired");
    this.stop();
    await this.dropConn(why);
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
    return this.queue.length > 0 || this.steered.length > 0 || this.refused !== null;
  }

  get queueItems(): QueuedMessage[] {
    return this.waiting().map(queued);
  }

  /** what waits with no bubble of its own yet. A message already in the transcript (steered, then
   * handed back by a stop or by the agent) just goes next: drawn as queued it would show twice, and
   * taking it back to edit would send a second copy. */
  private waiting(): QueueItem[] {
    // a message sent on another agent's behalf has no bubble to take back, so it is never queued
    // in sight either: its row appears when it is recorded
    return this.queue.filter((q) => !q.recorded && !q.handed);
  }

  onQueueChange: (() => void) | null = null;

  private queueChanged() {
    this.onQueueChange?.();
  }

  unqueue(index: number, taken?: (message: QueuedMessage) => void) {
    const item = this.waiting()[index];
    if (!item) return;
    this.queue.splice(this.queue.indexOf(item), 1);
    // whoever takes the message names its uploads before this lets go of them
    taken?.(queued(item));
    this.letGo(item);
    this.queueChanged();
  }

  /** a message that will never be recorded gives up the uploads it was holding */
  private letGo(item: QueueItem) {
    if (!item.recorded) this.d.attachments.uploads.release(uploadIds(item.attachments));
  }

  transcript(): TranscriptEntry[] {
    return this.log.entries;
  }

  note(event: AgentEvent) {
    this.emit(event);
  }

  /** every event the session writes, its own and a service's, passes the card tracking: a card
   * closing live (an ask ending, cancelled or answered) moves the held list the same way its
   * replay does on a restart. The restore walks the transcript itself, so it tracks nothing here. */
  private emit(event: AgentEvent) {
    // a turn's reply is scanned from its start (scanPictures)
    if (event.type === "turn-start") {
      this.replyText = "";
      this.pictured.clear();
    }
    const entry = this.log.append(event);
    this.d.onEvent(event, entry.seq);
    if (this.restored && this.trackCards(event)) this.syncStatus();
  }

  private setStatus(s: AgentStatus) {
    this.status = s;
    this.d.onStatus(s);
  }

  /** the drain loop holds the queue: messages wait for it or steer into its turn */
  private get running(): boolean {
    return this.turn !== null;
  }

  get stopping(): boolean {
    return this.turn?.stopping ?? false;
  }

  /** rows held open past the turn for something still going under the agent: commands it sent
   * to the background and still running, wakeups it booked and not yet back from */
  get holding(): number {
    return this.tasks.size + this.wakeups.size;
  }

  /** the earliest wakeup booked, as a time, or null while none is */
  get wakes(): number | null {
    return this.wakeups.next;
  }

  private holdingChanged() {
    this.d.onHolding?.();
    this.maybeArmReaper();
  }

  private setStopping(on: boolean) {
    const turn = this.turn;
    if (!turn || turn.stopping === on) return;
    turn.stopping = on;
    this.d.onStopping?.();
  }

  /** A message from the person. One sent past an open card is their answer to it: the agent is
   * blocked on the card and would read nothing until it closed, so the card closes as passed and
   * the message is what the turn carries on with. Toyon's own message answers nothing, and
   * neither does one sent on from another chat: the card is the person's to answer, and the
   * message waits behind it. */
  send(text: string, opts: SendOpts = {}) {
    if (this.stopped) return log.warn(this.d.worktreeId, "send after close dropped");
    if (!opts.asked && !opts.keepCards) for (const ask of [...this.asks.values()]) ask.settle("skipped");
    // a list held for a plan card while the mode chip has since left plan mode: no card is coming
    // for it, so it is Toyon's own card before the message goes
    this.showHeld();
    this.post(text, opts);
  }

  private post(text: string, opts: SendOpts = {}) {
    const steer = this.deliver(text, opts);
    if (steer) fireAndForget(this.d.worktreeId, steer, "agent steer");
  }

  /** `post`, handing back the steer in flight, settled once the agent has taken the message into
   * its turn; nothing when the message went to the queue instead. Throws as `send` does for an
   * attachment that cannot go. */
  private deliver(text: string, opts: SendOpts = {}): Promise<void> | undefined {
    const { context, attachments, asked, handed } = opts;
    const item: QueueItem = {
      text,
      context,
      ...(attachments?.length ? { attachments } : {}),
      ...(asked ? { asked: asked.kind } : {}),
      ...(handed ? { handed } : {}),
    };
    // Toyon's own message is recorded as it is sent, however long it waits for its turn: it has
    // no bubble to take back, so it is never drawn as queued, and the row saying why it was sent
    // stands from the moment of the failure
    if (asked) {
      this.emit({ type: "fix-asked", text, ts: Date.now(), ...asked });
      item.recorded = { attachments: [] };
    }
    // held from here until the message is recorded, which for a queued one is turns away
    this.d.attachments.uploads.hold(uploadIds(attachments));
    // sending during a turn means "while you are doing that": an agent that takes steering reads the
    // message as part of the work it is already on, which is the whole reason a person types then.
    // A stop already on its way is the exception — that turn is going away, so the message waits.
    // So does a hold: the tree is being rebased under the agent, and steering it now would have
    // it read and write files git is rewriting.
    if ((this.running || this.own) && !this.turn?.stopping && !this.held && this.live?.conn.steering) {
      return this.steer(item);
    }
    this.enqueue(item);
    return undefined;
  }

  private enqueue(item: QueueItem) {
    this.queue.push(item);
    this.queueChanged();
    if (!this.running && !this.held) fireAndForget(this.d.worktreeId, this.drain(), "agent drain");
  }

  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (!this.held && !this.running && this.queue.length > 0)
        fireAndForget(this.d.worktreeId, this.drain(), "agent drain");
    };
  }

  /** A message that joins the turn in flight. The agent settles that turn once, at its real end, so
   * the running prompt keeps owning turn-start and turn-end; all this adds to the transcript is the
   * person's own bubble, in the place they sent it. */
  private async steer(item: QueueItem) {
    item.recorded ??= await this.record(item);
    const live = this.live;
    // writing the attachments is a window the turn can settle in, and then this is a plain message
    if (!live || !(this.running || this.own) || this.turn?.stopping) return this.enqueue(item);
    // unanswered from the moment it goes out: a stop can land before the agent replies
    this.steered.push(item);
    this.steerMark = this.streamingId;
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
          // prompt itself with it, since nothing here would be tracking a turn it started alone.
          // `priority: "next"` asks for the message between steps, once the running tool call has
          // returned, the way the terminal queues a line typed during work. An adapter that reads
          // it (claude-agent-acp#1350) stops cutting the call; one that does not ignores the key
          // and keeps pre-empting, which `preempted` below still accounts for.
          _meta: { steering: { idleBehavior: "promptRequired", priority: "next" } },
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
      return;
    }
    // an adapter that reports the calls a steer dropped needs no marking (wire.ts)
    if (this.live === live && wireFlags(live.conn.spec.id).cutCallUnreported) preempted(live.tools);
  }

  /** Words or a call from the agent while a steer is unanswered: it is answering. Past a stop the
   * same words mean the cancel has not taken yet and the agent is answering what the stop handed
   * back, so the copies leave the queue rather than run again once the turn ends. Only while that
   * turn is still ending: a later turn's words say nothing about a copy still waiting. */
  private answered() {
    this.steered = [];
    if (!this.turn?.stopping || !this.queue.some((q) => q.handedBack)) return;
    this.queue = this.queue.filter((q) => !q.handedBack);
    this.queueChanged();
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
    this.setStopping(true);
    // what the agent had not got to goes first, ahead of anything sent after it
    if (this.steered.length > 0) {
      for (const item of this.steered) item.handedBack = true;
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
    for (const item of this.queue) this.letGo(item);
    this.queue = [];
    this.steered = [];
    this.queueChanged();
    // a card still open here was not stopped by anyone: the daemon is going (a restart, mostly)
    // and the agent's process with it. Esc settles its card as cancelled before any restart
    // begins, so by now the two tell apart, and the shell reopens this one after the reload.
    this.cancelAsks("expired");
    this.stop();
    await this.dropConn("closing");
    await this.log.flush();
  }

  private async drain() {
    // the prompt going out is the next turn, so the one the agent was on alone is over
    this.endOwn("end_turn");
    // A wakeup it booked stays booked: the runtime fires it after this turn all the same, so the
    // row waits on through the turn, and the turn the fire starts is what ends it (trackOwn).
    this.turn = { open: false, stopping: false };
    this.clearReaper();
    this.setStatus("working");
    let item: QueueItem | null = null;
    try {
      // a hold that began during a turn stops the queue after it: the release drains the rest
      while (this.queue.length > 0 && !this.held) {
        item = this.queue.shift()!;
        this.queueChanged();
        const turn = { open: false, stopping: false };
        this.turn = turn;
        try {
          await this.runTurn(item);
        } catch (e) {
          if (!turn.stopping) throw e;
          // the cancel's own error ends the turn; a failure before the turn began (the attachment
          // copy) under a pending stop is not the stop's doing, and the message would otherwise
          // vanish without a word
          if (turn.open) this.endTurn("interrupted");
          else this.emit({ type: "agent-error", message: this.describe(e), ts: Date.now() });
        }
        // the stop was for that turn: what was queued behind it, or sent while its cancel settled,
        // goes next without the status dropping to idle in between
        this.steered = [];
        for (const q of this.queue) q.handedBack = false;
        this.setStopping(false);
      }
      // a handoff card proposed during the turn is still a person's answer owed once
      // the turn is over: the row keeps reading waiting from it, not idle
      this.setStatus(this.openCards.size > 0 ? "waiting" : "idle");
    } catch (e) {
      // an AWS session that lapsed under Claude on Bedrock: the agent's own logins would not help,
      // so the card gets the daemon's. Read before the generic phrasing, which it can also match
      const aws = this.conn && AWS_EXPIRED_RE.test(this.describe(e)) ? this.awsAuth() : null;
      if (this.conn && (aws || isAuthRequired(e) || this.rejectedCredential(e))) {
        const rejected = !isAuthRequired(e);
        // a refused credential is a plain turn failure, so the provider's own words go out first:
        // without them "not logged in" would contradict an agent that thinks it is. The AWS card
        // contradicts nothing, so its words ride the card instead of a row above it
        if (rejected && !aws) this.emit({ type: "agent-error", message: this.describe(e), ts: Date.now() });
        // the process stays: a login runs over the same connection, then the message goes again
        this.refused = item;
        this.emit({
          type: "agent-auth-required",
          agent: this.conn.spec.id,
          agentName: this.conn.spec.name,
          ...(aws
            ? {
                methods: awsMethods(aws, this.conn.spec.id === "claude"),
                provider: "aws" as const,
                detail: this.describe(e),
                ...(aws.refresh ? { refresh: aws.refresh } : {}),
              }
            : this.offeredMethods(this.conn)),
          ...(rejected ? { rejected: true } : {}),
          ts: Date.now(),
        });
        // the turn's own end, after the card and before the status: the stop record is read off
        // the transcript on the status edge, and the card is what this turn is waiting on
        this.endTurn("auth");
        this.setStatus("error");
      } else {
        this.emit({ type: "agent-error", message: this.describe(e), ts: Date.now() });
        this.endTurn("failed");
        this.setStatus("error");
        // whatever state the adapter is in, the next prompt starts from a fresh process
        fireAndForget(this.d.worktreeId, this.dropConn("error"), "drop agent after error");
      }
    } finally {
      this.steered = [];
      for (const q of this.queue) q.handedBack = false;
      this.setStopping(false);
      this.turn = null;
      this.maybeArmReaper();
    }
  }

  /** The turn's last event, once: nothing when no turn-start is open (a failure before the turn
   * began has no bracket to close). A stop pressed for this turn has landed with it, whichever
   * way it ended, so the press's mark falls here too. A plain emit otherwise: the drain loop goes
   * straight on to the next queued turn, so the status is not touched, and the reaper is armed
   * once the loop is done. */
  private endTurn(stopReason: string) {
    const turn = this.turn;
    if (!turn?.open) return;
    turn.open = false;
    this.emit({ type: "turn-end", stopReason, ts: Date.now() });
    // a pieces list handed over for a plan card that never came is the person's to answer anyway
    this.showHeld();
    this.setStopping(false);
  }

  /** A side question. Null is the agent's answer when it has none to give (no quick model, a
   * session already closed); a question that could not be put, the process dying under it or the
   * adapter refusing the session, throws, since the caller has to tell the two apart: a landing
   * verdict settles on the first and waits on the second. */
  async ask(system: string, prompt: string, opts: AskOpts = {}): Promise<string | null> {
    if (this.stopped) return null;
    this.asking++;
    this.clearReaper();
    try {
      const conn = await this.ensureConn("an ask");
      return await askOnce(conn.ctx, {
        cwd: this.d.cwd,
        system,
        prompt,
        spec: conn.spec,
        ...(opts.quick ? { quick: opts.quick } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
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
    } finally {
      this.asking--;
      this.maybeArmReaper();
    }
  }

  async authenticate(methodId: string, apiKey?: string): Promise<AuthOutcome> {
    const conn = await this.ensureConn("login");
    if (methodId === AWS_LOGIN_METHOD || methodId === AWS_REFRESH_METHOD) return this.authenticateAws(methodId);
    const method = conn.authMethods.find((m) => m.id === methodId);
    if (!method) throw new UserError(`${conn.spec.name} offers no login method "${methodId}"`);
    if (this.planWithheld(conn, methodId)) {
      throw new UserError("Signing in with a Claude plan is turned off by your organization's policy");
    }
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

  /** the daemon's own logins for a lapsed AWS session: `aws sso login` as the login tab, or the
   * setting that has Claude Code run it itself from now on */
  private async authenticateAws(methodId: string): Promise<AuthOutcome> {
    const command = awsLoginCommand(this.awsAuth().profile);
    if (methodId === AWS_LOGIN_METHOD) {
      // through the login shell, so `aws` is found where the terminal pane finds it
      return { kind: "terminal", run: { command: process.env.SHELL || "sh", args: ["-lc", command], env: {} } };
    }
    const file = setAwsAuthRefresh(this.claudeConfigDir(), command);
    log.info(this.d.worktreeId, `awsAuthRefresh set to "${command}" in ${file}`);
    // the setting is read at start: the process that failed goes, and the message sent again
    // spawns one that refreshes the session itself before it retries the request
    await this.dropConn("settings changed");
    this.loggedIn();
    return { kind: "done" };
  }

  private awsAuth(): AwsAuth {
    return readAwsAuth(this.claudeConfigDir(), this.d.cwd);
  }

  private claudeConfigDir(): string {
    return this.d.claudeConfigDir ?? claudeConfigDir();
  }

  loggedIn() {
    this.emit({ type: "agent-auth-ok", ts: Date.now() });
    this.retry();
  }

  retry() {
    const item = this.refused;
    this.refused = null;
    // the item itself, as it was recorded: its bubble is already on the chat and its attachments
    // are written, and the uploads they were copied from went when that happened
    if (item && !this.stopped) this.enqueue(item);
  }

  /** a plan sign-in the managed policy withholds: the spec marks the method, the policy says no */
  private planWithheld(conn: Conn, methodId: string): boolean {
    return this.d.planSignIn?.() === false && conn.spec.terminalLogins?.[methodId]?.plan === true;
  }

  /** the login methods the card may show, and whether one was left out for the policy's sake */
  private offeredMethods(conn: Conn): { methods: AuthMethodInfo[]; withheld?: boolean } {
    const kept = conn.authMethods.filter((m) => !this.planWithheld(conn, m.id));
    const methods = kept.map(authMethodInfo);
    return kept.length === conn.authMethods.length ? { methods } : { methods, withheld: true };
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
  private async record({ text, attachments, handed }: QueueItem): Promise<Recorded> {
    const stored: Stored[] = [];
    try {
      for (const a of attachments ?? [])
        stored.push(await this.d.attachments.put(this.d.worktreeId, this.seq[a.kind]++, a));
    } finally {
      // copied, or never going to be: a message that fails here is not tried again
      this.d.attachments.uploads.release(uploadIds(attachments));
    }
    const attached = stored.length ? { attachments: stored.map((s) => s.ref) } : {};
    // a message sent on another agent's behalf is Toyon's row on the chat, not a bubble
    if (handed) this.emit({ type: "handed", ...handed, text, ...attached, ts: Date.now() });
    else this.emit({ type: "user-message", text, ts: Date.now(), ...attached });
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
    try {
      await this.d.beforeTurn?.();
    } catch (e) {
      // bookkeeping for the changes panel: the turn goes whether or not it was kept
      log.warn(this.d.worktreeId, "before-turn hook failed", e);
    }
    this.emit({ type: "turn-start", ts: Date.now() });
    this.turn!.open = true;
    const live = await this.ensureLive("a turn");
    await this.applyMode(live);
    await this.applyOption(live, "model");
    await this.applyOption(live, "thought_level");
    // a stop that landed while the agent was starting or being set up had no turn to cancel, so the
    // prompt must not go out at all: esc straight after a send would otherwise do nothing. Nothing
    // runs between this check and the request being written, so a later stop's cancel follows it.
    if (this.turn?.stopping) {
      this.endTurn("interrupted");
      return;
    }
    const carried = this.carried(live, item.recorded.attachments);
    const standing = await this.d.standing?.();
    const prefix = live.prefixPending ? (this.d.systemAppend?.() ?? SYSTEM_APPEND) : undefined;
    live.prefixPending = false;
    const res = await live.conn.ctx.request(acp.methods.agent.session.prompt, {
      sessionId: live.sessionId,
      prompt: buildPrompt(item.text, this.contextFor(item, standing), prefix, carried),
    });
    this.endTurn(mapStopReason(res.stopReason));
  }

  /** what the shell attached when the message was sent, then what this worktree is called and
   * where its work stands, which siblings the message names, then where the preview stands now
   * that it is going out and what its page has thrown, then what landed elsewhere since the last
   * message, wrapped as one block */
  private contextFor(item: QueueItem, standing?: string): string | undefined {
    return ambientBlock([
      ...(item.context ?? []),
      this.d.self?.(),
      standing,
      ...(this.d.mentioned?.(item.text) ?? []),
      this.d.preview?.(),
      this.d.pageErrors?.(),
      ...this.landedSince(),
    ]);
  }

  /** One sentence per worktree this one handed work to that has landed since the message before
   * this one. Derived from the transcript rather than kept: the message going out is the newest
   * record on it, so the events between the one before and it are what this prompt is the first to
   * carry, and the next prompt starts past them. */
  private landedSince(): string[] {
    const entries = this.log.entries;
    let i = entries.length - 1;
    while (i >= 0 && !isMessage(entries[i]!.event)) i--;
    const out: string[] = [];
    for (i--; i >= 0; i--) {
      const e = entries[i]!.event;
      if (isMessage(e)) break;
      if (e.type === "piece-landed") {
        out.unshift(pieceLandedContext(e.title, e.repoName, e.url, e.same, e.again, e.awaited));
      }
    }
    return out;
  }

  /** the adapter process, spawned and initialized once; concurrent callers share the spawn.
   * `why` names what wanted it, for the log: what keeps adapters up is read from these lines */
  private ensureConn(why: string): Promise<Conn> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    this.connecting = this.openConn(why).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openConn(why: string): Promise<Conn> {
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
    this.noteProcess(link, true);
    log.info(this.d.worktreeId, `agent ${spec.id} started for ${why} (pid ${link.pid ?? "unknown"})`);
    const ctx = link.conn.agent;
    // the process dying while idle must not leave a dead handle for the next prompt to use
    link.exited.then(() => {
      this.noteProcess(link, false);
      if (this.conn?.link === link) {
        log.warn(this.d.worktreeId, "agent process exited while idle");
        this.conn = null;
        this.live = null;
        this.d.mcp?.close();
        this.cancelAsks();
        this.tasks.endAll("the agent stopped, and the command with it");
        this.wakeups.endAll("the agent stopped before it woke");
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
        // the SDK types the capability as an object; both bundled adapters send `true`
        mcpServers: takesHttpMcp(init) && this.d.mcp ? [this.d.mcp.open()] : [],
        side,
        commands,
      };
      this.d.onAuth?.(spec.id, { canLogout: supportsLogout(init.agentCapabilities) });
      return this.conn;
    } catch (e) {
      fireAndForget(this.d.worktreeId, link.kill(), "kill agent after failed start");
      this.noteProcess(link, false);
      throw e;
    }
  }

  /** the worktree's session on the connection, started once; concurrent callers share the start.
   * A warm-up and the send it was for arrive together, and a session each would leave the prompt
   * on one while the updates of another are the ones listened to. */
  private async ensureLive(why: string): Promise<Live> {
    const conn = await this.ensureConn(why);
    if (this.opening?.conn === conn) return this.opening.live;
    if (this.live?.conn === conn) return this.live;
    const live = this.openLive(conn).finally(() => {
      if (this.opening?.live === live) this.opening = null;
    });
    this.opening = { conn, live };
    return live;
  }

  /** resumed when the agent remembers the session, else new */
  private async openLive(conn: Conn): Promise<Live> {
    const additionalDirectories = conn.bounds.gitDir ? [conn.bounds.gitDir] : [];
    const meta = sessionMeta(conn.spec, this.d.systemAppend?.());
    let sessionId = this.d.getSessionId();
    let modes: acp.SessionModeState | null | undefined;
    let configOptions: acp.SessionConfigOption[] | null | undefined;
    let resumed = false;
    if (sessionId && conn.resumeSession) {
      try {
        // the same meta as session/new: the adapter builds a resumed session's query from this
        // request alone, so a resume without it runs the agent on its bare preset with none of
        // Toyon's rules
        const r = await conn.ctx.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd: this.d.cwd,
          mcpServers: conn.mcpServers,
          additionalDirectories,
          ...(meta ? { _meta: meta } : {}),
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
        mcpServers: conn.mcpServers,
        additionalDirectories,
        ...(meta ? { _meta: meta } : {}),
      });
      sessionId = r.sessionId;
      modes = r.modes;
      configOptions = r.configOptions;
      if (!this.stopped) this.d.setSessionId(sessionId);
    }
    const options = readOptions(configOptions);
    this.emit({ type: "session-info", sessionId: sessionId!, ...currentValues(options) });
    // before the record's own choices go on below: a fresh session's values are the agent's defaults
    this.learn(options, !resumed);
    const modeOption = modes ? null : readModeOption(configOptions);
    const live: Live = {
      conn,
      sessionId: sessionId!,
      prefixPending: !resumed && conn.spec.systemPrompt === "prompt-prefix",
      tools: new Map(),
      modeIds: modes ? modes.availableModes.map((m) => m.id) : (modeOption?.ids ?? null),
      modeId: modes?.currentModeId ?? modeOption?.current ?? null,
      modeConfigId: modeOption?.id ?? null,
      options,
    };
    this.live = live;
    // the worktree's mode, model and effort, applied now so a resumed session does not answer its
    // first prompt with whatever the agent remembered. Effort last: its choices depend on the model
    await this.applyMode(live);
    await this.applyOption(live, "model");
    await this.applyOption(live, "thought_level");
    // the push that landed while session/new was in flight, now that the id is known. Only when
    // there is one: an agent that does not re-push on resume keeps the list it already had.
    const pushed = conn.commands.get(sessionId!);
    if (pushed) this.setCommands(pushed);
    return live;
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
    // the record's id as this agent lists it now: the adapter renames its ids between versions,
    // and the record follows the rename so the next turn finds it listed. An id off the list goes
    // through to an adapter that takes one (wire.ts); one that checks values would refuse it.
    const listed =
      category === "model" ? relistChoice(wanted, opt.choices) : opt.ids.includes(wanted) ? wanted : undefined;
    const target =
      listed ?? (category === "model" && !wireFlags(live.conn.spec.id).modelIdOffList ? wanted : undefined);
    if (target === undefined) {
      log.info(this.d.worktreeId, `acp: ${category} ${wanted} is not offered; ${opt.current} answers`);
      // a model the agent does not list (one the account can no longer pay for) would otherwise
      // read on the chip while another answers. The record is cleared to the agent's own choice,
      // which is what answers, so the chat says so once and not on every turn. An effort is left
      // alone: its list follows the model, and the next model may have it again.
      if (category === "model") {
        this.emit({ type: "model-switched", name: currentName(opt), asked: wanted, ts: Date.now() });
        this.d.onOptionChanged?.(category, "");
      }
      return;
    }
    if (target !== wanted) this.d.onOptionChanged?.(category, target);
    if (target === opt.current) return;
    const r = await live.conn.ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: live.sessionId,
      configId: opt.id,
      value: target,
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

  private learn(options: LiveOptions, fresh = false) {
    for (const [category, opt] of options) {
      this.d.onOptionsLearned?.(category, opt.choices, fresh ? opt.current : undefined);
    }
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
      const origins = this.d.commandOrigins?.() ?? new Map();
      const mapped = markOrigins(mapCommands(params.update.availableCommands), origins);
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
    // the plan figures ride the context figures, but they are the account's and not this
    // worktree's: they go to the agent's record, not into the transcript with the rest
    if (params.update.sessionUpdate === "usage_update" && this.conn) {
      const limits = parseRateLimit(params.update._meta, Date.now());
      if (limits) this.d.onLimits?.(this.conn.spec.id, limits);
    }
    // the agent changed mode on its own: remember, so the next turn's applyMode compares against
    // what it is in, not what we last asked for. Into its plan mode (Claude's EnterPlanMode tool
    // does this), the record follows: the chip and the rail say plan while it holds, and the next
    // turn keeps it there rather than pushing the write mode back. Out of plan mode (an approved
    // ExitPlanMode) the record was set by the approval; any other write mode is left alone, since
    // the agent's id cannot say whether it means auto or ask.
    if (params.update.sessionUpdate === "current_mode_update") {
      live.modeId = params.update.currentModeId;
      const planId = agentModeFor(live.conn.spec, "plan", live.modeIds ?? undefined);
      if (planId && live.modeId === planId && this.mode() !== "plan") this.d.setMode?.("plan");
      return;
    }
    // the agent changed its own model or effort (a slash command can): the record is told, since
    // the next turn applies the record and would otherwise undo the switch. Only the categories
    // whose value moved: an update that only re-lists the choices pins nothing.
    if (params.update.sessionUpdate === "config_option_update") {
      const before = live.options;
      this.absorb(live, params.update.configOptions);
      for (const [category, opt] of live.options) {
        const was = before.get(category)?.current;
        if (was === opt.current) continue;
        this.d.onOptionChanged?.(category, opt.current);
        // a model the person did not pick is news: the chip follows it, but nobody looks there
        if (category === "model" && was !== undefined) {
          this.emit({ type: "model-switched", name: currentName(opt), ts: Date.now() });
        }
      }
    }
    // a picture a call returned is written as the tool-end that names it goes out; the http side
    // waits on the write, so the row's fetch never beats the bytes to the disk
    const events = mapUpdate(
      params.update,
      live.tools,
      this.d.worktreeId,
      (file, bytes) =>
        fireAndForget(this.d.worktreeId, this.d.attachments.putToolImage(this.d.worktreeId, file, bytes), "tool image"),
      // an adapter that reports a backgrounded command's finish itself needs no tail (wire.ts)
      wireFlags(live.conn.spec.id).backgroundFinish
        ? (toolId, start, input) => {
            const taken = this.tasks.start(toolId, start, input);
            if (taken) this.holdingChanged();
            return taken;
          }
        : undefined,
      (toolId, until) => (until === null ? this.wakeups.stop() : this.wakeups.start(toolId, until)),
    );
    this.forward(live, events);
    this.holdInput(live, params.update);
  }

  private forward(live: Live, events: AgentEvent[]) {
    if (!this.running) this.trackOwn(events);
    for (const ev of events) {
      // a call, or words under a message other than the one the steer cut off, are the agent
      // answering it: that message's own deltas can still trail in after the pre-emption. An
      // adapter that names no message leaves any words to clear the steer, as before, but not to
      // drop a handed-back copy: its tail and its answer look the same, and a copy run twice is
      // the smaller wrong than a message lost.
      if (ev.type === "tool-start") this.answered();
      else if (ev.type === "text-delta") {
        if (ev.messageId === undefined) this.steered = [];
        else if (ev.messageId !== this.steerMark) this.answered();
        this.streamingId = ev.messageId;
      }
      // the mapper does not know the session id; the transcript wants the real one
      this.emit(ev.type === "session-info" ? { ...ev, sessionId: live.sessionId } : ev);
      if (ev.type === "text-delta") this.scanPictures(ev.text);
    }
  }

  /** A picture the reply names by a path (pictures.ts) is copied into the store as soon as the
   * markdown naming it is whole, and the chat is told by an event behind the delta; the event can
   * trail the turn, since the copy is a read of the disk. The whole reply is scanned each time,
   * so a link split across chunks is seen once it closes; a path seen is not copied twice. */
  private scanPictures(chunk: string) {
    this.replyText += chunk;
    for (const href of pictureLinks(this.replyText)) {
      if (this.pictured.has(href) || this.pictured.size >= PICTURES_MAX) continue;
      this.pictured.add(href);
      fireAndForget(
        this.d.worktreeId,
        adoptPicture(this.d.attachments, this.d.worktreeId, this.d.cwd, href).then((picture) => {
          if (picture) this.emit({ type: "picture", ...picture });
        }),
        "reply picture",
      );
    }
  }

  /** An input the mapper held back goes out once its call has been quiet for a while. Nothing on
   * the wire says an input is whole, and a call that then runs for a minute sends nothing more
   * until it is done; the row would say the command was still being written the whole time. */
  private holdInput(live: Live, update: acp.SessionUpdate) {
    if (update.sessionUpdate !== "tool_call_update") return;
    // an adapter that says when a call starts releases the input itself, by that status (wire.ts)
    if (!wireFlags(live.conn.spec.id).noStartSignal) return;
    const toolId = update.toolCallId;
    const memo = live.tools.get(toolId);
    const held = memo?.held;
    if (!memo || !held) return;
    const t = setTimeout(() => {
      // a later update replaced what was held or sent it on, and a turn that ended took the row.
      // A call a steer cut is quiet because nothing more is coming, not because it is whole.
      if (this.live !== live || memo.held !== held || memo.cut || !(this.running || this.own)) return;
      const sent = release(toolId, memo);
      if (sent) this.forward(live, [sent]);
    }, this.d.inputHoldMs ?? INPUT_HOLD_MS);
    t.unref?.();
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
    const parts = permissionParts(params);
    const detail = parts.detail ?? "";
    // the card names a file that is already there to open: the agent's own plan file (Claude
    // reports it beside the plan, and goes on editing it after a no), else one written before the
    // card goes out; a worktree that would not take it leaves the plan on the card
    const ownFile = plan ? stringField(params.toolCall.rawInput, "planFilePath") : undefined;
    const planPath = plan ? ((await this.d.onPlan?.(detail, ownFile)) ?? null) : null;
    // a plan's options are all one-time answers, led by the auto yes as Claude's own dialog leads.
    // An edit's or a command's include the agent's "always allow", which would write a rule into
    // its settings and take every later request of that shape away from this policy; the card
    // offers only what keeps the mode meaning something
    const offered = plan ? orderPlanOptions(params.options) : params.options.filter((o) => o.kind !== "allow_always");
    const choices: AskChoice[] = offered.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }));
    // the pieces list the agent handed over for this plan rides beside the card, and its yes is
    // the list's yes; the list stays held until a choice is made, so a card a stop cancels leaves
    // it for the turn's end to show as Toyon's own
    const handoff = plan ? this.heldHandoff : null;
    // no list for this plan: Toyon may read one off it, which lands as a held list while the card
    // is up and is answered with it (a late list, below)
    if (plan && planPath && !handoff && detail.trim()) this.d.onPlanUnsplit?.(detail, planPath);
    return this.openAsk<acp.RequestPermissionResponse>(
      (id) => ({
        type: "agent-permission",
        id,
        title: parts.title,
        ...(parts.command ? { command: parts.command } : {}),
        ...(detail ? { detail } : {}),
        ...(planPath ? { plan: planPath } : {}),
        ...(handoff ? { handoff } : {}),
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
        const res: acp.RequestPermissionResponse = { outcome: { outcome: "selected", optionId: choice.id } };
        const approved = choice.kind === "allow_once" || choice.kind === "allow_always";
        if (plan && approved) this.d.setMode?.(modeAfterPlan(choice.name));
        // after the mode, so the act reads the mode the work runs in; a list handed over late,
        // while the card was open, is answered with it too
        const decided = handoff ?? (plan ? this.heldHandoff : null);
        if (decided) {
          if (this.heldHandoff === decided) this.heldHandoff = null;
          this.d.onHandoff?.(decided, approved);
        }
        // the yes said yes to the file, which may no longer be the plan the agent holds
        if (plan && approved && planPath) return this.sayPlanEdited(detail, planPath).then(() => res);
        // the no took the agent's list with it, and the agent heard only that the hand-over went
        // through; a list Toyon read for the card was never the agent's to hand over again
        if (plan && !approved && decided && this.proposed(decided)?.by !== "toyon") {
          return this.sayHandoffDeclined().then(() => res);
        }
        return res;
      },
    );
  }

  /** the proposal a pieces list id names, from the transcript */
  private proposed(id: string) {
    const list = this.log.entries.findLast(({ event }) => event.type === "handoff-proposed" && event.id === id)?.event;
    return list?.type === "handoff-proposed" ? list : undefined;
  }

  /** A plan sent back with the agent's own list beside it. The rejection is an option id, and the
   * handoff tool's result still reads as a hand-over that stands, so the agent would send the next
   * plan up without a list; the word that the list went too goes in as a message, awaited ahead
   * of the answer as `sayPlanEdited` is. */
  private async sayHandoffDeclined() {
    try {
      await this.deliver(
        "The pieces list you handed over went back with the plan. Hand over a list again with `handoff` before you ask for approval. Where the person put each piece carries over to the new list by piece title, so keep the title of a piece that stands.",
      );
    } catch (e) {
      // the no still goes back; a reply that fails would read to the agent as a refusal
      log.warn(this.d.worktreeId, "the declined list was not sent", e);
    }
  }

  /** A plan approved after it was rewritten. A permission answer is an option id and nothing else,
   * so the agent would go and build the version it proposed; the file it must work from goes in as
   * a message instead, which steers into the turn the approval releases. Awaited ahead of the
   * approval itself, for the reason `answer` gives: steered once the card is closed on the wire,
   * it would cut the plan tool off as it returns. */
  private async sayPlanEdited(proposed: string, path: string) {
    try {
      if (!(await this.d.planEdited?.(path, proposed))) return;
      await this.deliver(`I edited the plan before approving it. Build what is in ${path}, not the plan you proposed.`);
    } catch (e) {
      // the approval still goes back; a reply that fails would read to the agent as a refusal
      log.warn(this.d.worktreeId, "the edited plan was not sent", e);
    }
  }

  private onElicit(
    params: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): acp.CreateElicitationResponse | Promise<acp.CreateElicitationResponse> {
    const live = this.live;
    // a side session (naming, the landing questions) shares this connection and has no chat to draw a
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
      form.questions.map((q) => q.header || q.text || params.message),
    );
  }

  /** the shared half of both ask kinds: emit the card, park the resolver, and make sure every way
   * out settles the agent's request exactly once */
  private openAsk<R>(
    card: (id: string) => AgentEvent,
    respond: (outcome: AskOutcome, reply?: AskReply) => R | Promise<R>,
    signal?: AbortSignal,
    headers?: string[],
  ): Promise<R> {
    const id = randomUUID();
    return new Promise<R>((resolve) => {
      const settle = (outcome: AskOutcome, reply?: AskReply, before?: () => Promise<void>) => {
        if (!this.asks.delete(id)) return;
        signal?.removeEventListener("abort", onAbort);
        this.emit({ type: "agent-ask-end", id, outcome, ...recorded(reply), ts: Date.now() });
        this.syncStatus();
        // the card is closed here and open on the wire until the resolve: what goes before it
        // reaches the agent while its request is still pending
        const res = respond(outcome, reply);
        resolve(before ? before().then(() => res) : res);
      };
      const onAbort = () => settle("cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.asks.set(id, { settle, ...(headers ? { headers } : {}) });
      this.emit(card(id));
      this.syncStatus();
    });
  }

  /** An answer closes its card. What was attached to the card cannot go in the answer (an
   * elicitation's values are words), and neither can words typed beside a pick (a permission
   * answer is an option id and nothing else), so they follow as a message of the person's own:
   * the turn is still running, so it joins it the way a message typed then would, behind the tool
   * result the answer became. Posted, not sent: a send closes every other open card as passed,
   * and this message answers nothing. A pass sends nothing on.
   *
   * It goes to the agent before the answer does, while the card's request is still open on the
   * wire. Claude delivers a message steered with no card open by aborting the step it is on, and
   * right after an answer that step is the ask tool itself, still returning the answer: the tool
   * result came back as an interruption and the agent read the question as unanswered. A message
   * steered while a card is open is delivered after the step instead, so the answer and what
   * followed it reach the agent together. */
  answer(askId: string, reply: AskReply, followUp?: FollowUp) {
    const ask = this.asks.get(askId);
    // two shells can watch one worktree; the other one answering first is normal, not an error
    if (!ask) return log.debug(this.d.worktreeId, `answer for an ask that already closed (${askId})`);
    const skipped = reply.kind === "answers" && !reply.answers;
    const note = reply.kind === "choice" ? reply.note?.trim() : undefined;
    const attachments = skipped ? [] : (followUp?.attachments ?? []);
    const headers = ask.headers ?? [];
    const text = headers.length === 1 ? `with my answer to "${headers[0]}"` : "with my answers";
    const before =
      note || attachments.length
        ? async () => {
            try {
              if (note) await this.deliver(note);
              if (attachments.length) await this.deliver(text, { attachments });
            } catch (e) {
              // the answer still goes back: the card is closed, and a reply that fails would read
              // to the agent as a question it could not put
              log.warn(this.d.worktreeId, "what followed the answer did not go", e);
            }
          }
        : undefined;
    ask.settle(skipped ? "skipped" : "answered", reply, before);
  }

  /** every open card goes away with the turn or the process it belonged to. A card nobody stopped
   * ends as `expired` instead: the shell reads a cancelled card as a stop someone meant and keeps
   * it folded, and an expired one as a question still owed, so it brings it back open. */
  private cancelAsks(outcome: AskOutcome = "cancelled") {
    for (const ask of [...this.asks.values()]) ask.settle(outcome);
  }

  /** a card is opened inside a running turn, so the turn's own status would say "working" while
   * the agent is in fact blocked on a person; a handoff card holds no turn at all, and is still
   * a person's answer owed */
  private syncStatus() {
    if (this.status === "error") return;
    const waiting = this.asks.size > 0 || this.openCards.size > 0;
    this.setStatus(waiting ? "waiting" : this.running || this.own ? "working" : "idle");
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
      // the agent back on its own is the wakeup it booked: its row ends ahead of the turn
      this.wakeups.wake("woke");
      this.emit({ type: "turn-start", ts: Date.now() });
      this.syncStatus();
    }
    for (const e of events) {
      if (e.type === "tool-start") this.own.open.add(e.toolId);
      // a command sent to the background has returned to the agent, and the turn goes on without it
      else if (e.type === "tool-end" || (e.type === "tool-update" && e.background)) this.own.open.delete(e.toolId);
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

  /** nothing to hold the process for: no turn, no question out, no card open, and nothing held
   * open under it (a command sent to the background, whose process would go with the reap, or a
   * wakeup booked, whose timer would) */
  private quiet(): boolean {
    return !this.running && !this.own && !this.asking && this.asks.size === 0 && this.holding === 0;
  }

  private maybeArmReaper() {
    if (this.quiet() && this.conn && !this.stopped) this.armReaper();
  }

  private armReaper() {
    this.clearReaper();
    const idleMs = this.d.idleMs ?? DEFAULT_IDLE_MS;
    const t = setTimeout(() => {
      this.reaper = null;
      if (!this.quiet() || !this.conn) return;
      fireAndForget(this.d.worktreeId, this.dropConn(`idle for ${Math.round(idleMs / 60_000)} min`), "reap agent");
    }, idleMs);
    // a sleeping timer must not keep a test (or a shutdown) waiting
    t.unref?.();
    this.reaper = t;
  }

  private clearReaper() {
    if (this.reaper) clearTimeout(this.reaper);
    this.reaper = null;
  }

  private async dropConn(why: string) {
    // closing the connection aborts outbound requests only, so a card the agent is blocked on
    // would otherwise sit here forever with no process left to answer
    this.cancelAsks();
    this.tasks.endAll("the agent stopped, and the command with it");
    this.wakeups.endAll("the agent stopped before it woke");
    const conn = this.conn;
    this.conn = null;
    this.live = null;
    // the bearer the process held goes with it; the next spawn mints its own
    this.d.mcp?.close();
    if (!conn) return;
    log.info(this.d.worktreeId, `agent ${conn.spec.id} stopped: ${why} (pid ${conn.link.pid ?? "unknown"})`);
    conn.link.conn.close();
    await conn.link.kill();
    this.noteProcess(conn.link, false);
  }
}

/** whether the agent takes an HTTP MCP server at session start. The SDK types the flag as an
 * object or null; both bundled adapters send a boolean, so either spelling of yes counts. */
function takesHttpMcp(init: acp.InitializeResponse): boolean {
  const http: unknown = init.agentCapabilities?.mcpCapabilities?.http;
  return http === true || (typeof http === "object" && http !== null);
}

/** how many lines of a proposed file the card shows before it cuts */
const DETAIL_LINES = 80;

/** what the card is made of: a title that is always prose, the command a yes would run, and
 * markdown for what is neither (a plan, an edit's diff) */
export interface PermissionParts {
  title: string;
  command?: string;
  detail?: string;
}

function stringField(raw: unknown, key: string): string | undefined {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** The two agents put the plan in different places (Claude's ExitPlanMode renders it as a text
 * content block, Codex's plan review sends only rawInput.plan), and an edit arrives as a diff block
 * whose new text is what a person has to read to say yes. A command's request names the command
 * and the agent's sentence for it in different places too, and which of the two is the title has
 * changed between adapter versions; the input is where both are stable, so the command is read
 * from there and the sentence is the input's description, else whichever text the request carries
 * that is not the command. The card's title is the sentence, so a four-line pipeline is never what
 * a person reads as the question, and the command goes apart for the code face. */
export function permissionParts(params: acp.RequestPermissionRequest): PermissionParts {
  const { toolCall } = params;
  const parts: { text: boolean; md: string }[] = [];
  for (const c of toolCall.content ?? []) {
    if (c.type === "content" && c.content.type === "text") parts.push({ text: true, md: c.content.text });
    else if (c.type === "diff") {
      const lines = c.newText.split("\n");
      const shown = lines.slice(0, DETAIL_LINES).join("\n");
      const more = lines.length > DETAIL_LINES ? `\n… ${lines.length - DETAIL_LINES} more lines` : "";
      parts.push({ text: false, md: `\`${c.path}\`\n\n\`\`\`\n${shown}${more}\n\`\`\`` });
    }
  }
  const raw = toolCall.rawInput;
  const command = stringField(raw, "command");
  if (!command) {
    const detail = parts.map((p) => p.md).join("\n\n") || stringField(raw, "plan") || "";
    return { title: toolCall.title ?? toolCall.name ?? "the agent needs a decision", ...(detail ? { detail } : {}) };
  }
  const same = (a: string, b: string) => a.trim() === b.trim();
  // never the command itself, and never the tool's bare name, which an adapter sends as the title
  // when the agent wrote no sentence
  const prose = (s: string | undefined) => (s && !same(s, command) && s !== toolCall.name ? s : undefined);
  const title =
    stringField(raw, "description") ??
    parts.find((p) => p.text && prose(p.md))?.md ??
    prose(toolCall.title ?? undefined) ??
    "run this command?";
  // the sentence and the command have their own places on the card; a text that repeats either
  // is not detail
  const detail = parts
    .filter((p) => !(p.text && (same(p.md, title) || same(p.md, command))))
    .map((p) => p.md)
    .join("\n\n");
  return { title, command, ...(detail ? { detail } : {}) };
}

/** ACP's auth_required code means "no credential"; a credential the provider rejected has no code
 * of its own and arrives as the failed turn's text, so the provider's wording is all there is to
 * read. Kept to phrasings that can only be about credentials — a 403 is usually about permission
 * or quota, and asking someone to log in again would not help. */
const REJECTED_CREDENTIAL_RE =
  /\b401\b|unauthorized|invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?(error|failed)|api key (is )?(invalid|expired|incorrect)|incorrect api key|(token|credential)s? (have |has )?expired|expired (token|credential)|not (logged in|authenticated)/i;

/** `_meta` on the chat's session/new and resume: the person's tuning from agents.json under
 * toyon's own keys, so the rules ride every session and a tuning that names the same key does not
 * take them away. A resumed query is built from this request alone, so both carry the same one. */
export function sessionMeta(spec: AgentSpec, append = SYSTEM_APPEND): Record<string, unknown> | undefined {
  const meta = {
    ...spec.meta,
    ...(spec.systemPrompt === "meta-append" ? { systemPrompt: { append } } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

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
    a.every(
      (c, i) =>
        c.name === b[i]?.name &&
        c.description === b[i]?.description &&
        c.hint === b[i]?.hint &&
        c.origin === b[i]?.origin,
    )
  );
}
