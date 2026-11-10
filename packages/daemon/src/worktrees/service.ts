// Worktree lifecycle and landing: everything that decides what happens to a worktree. The
// transport layer (server/handlers.ts) calls in here and shapes replies; git/, runtime/ and the
// spare pool do the work.

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentEvent,
  type ArchivedWorktree,
  type AttachmentInput,
  baseIsRemote,
  baseOf,
  type CommitEntry,
  cachePolicy,
  canArchive,
  canGraft,
  canLand,
  canRename,
  coalesce,
  DEFAULT_MERGE_METHOD,
  describeDuration,
  type GitFileStatus,
  type GitInfo,
  hasOwnBranch,
  isBusy,
  isLead,
  isMain,
  isProvisional,
  isWriteTool,
  type LandedFacts,
  type Landing,
  type LandMark,
  type LandPolicy,
  landedNow,
  landPolicy,
  type ModelChoice,
  movedPastLand,
  notLandedWhy,
  type Owned,
  ownedBy,
  type PermissionMode,
  type ProcSource,
  type PrState,
  runSetup as procSetup,
  runTeardown as procTeardown,
  prStanding,
  prTaken,
  type RefKind,
  type RepoInfo,
  remoteOf,
  runCmd,
  runRemotes,
  type ShipOp,
  type Shipping,
  sentAt,
  shipNoun,
  type TrunkStatus,
  timeoutFor,
  type WorktreeInfo,
  type WorktreeStatus,
} from "@toyon/shared";
import type { OptionCategory, OptionField } from "../agent/acp/options.ts";
import type { Handed } from "../agent/adapter.ts";
import { attachmentsDirFor, isAttachmentFile } from "../agent/attachments.ts";
import { canonical } from "../agent/bounds.ts";
import { PLANS_DIR, writePlanDocNow } from "../agent/planDoc.ts";
import {
  type Failure,
  fixPrompt,
  type TierProcStanding,
  type TierStanding,
  type WorkStanding,
} from "../agent/prompt.ts";
import { firstAskOf } from "../agent/recap.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { makeNamer, taskText } from "../agent/tasks.ts";
import { sealOpenTurn, Transcript, type TranscriptEntry, transcriptPathFor } from "../agent/transcript.ts";
import { cloneTree } from "../core/clone.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import type { DraftStore } from "../drafts/store.ts";
import {
  archiveRef,
  checkOutKept,
  commitOf,
  dropLandRefs,
  handLanding,
  type KeptState,
  keepState,
  keptAt,
  type LandingRange,
  landingMark,
  landRef,
} from "../git/archive.ts";
import { excludeBlock } from "../git/exclude.ts";
import { GIT, git, gitOrThrow, gitRaw, isGitRepo, NO_PROMPT, nulSplit, RUN_CEILING_MS, run } from "../git/exec.ts";
import {
  commitWorktree,
  fetchBase,
  type LandWatch,
  landingCommit,
  landLocally,
  mergePr,
  openPr,
  pushBranch,
  pushLanding,
  requireLinear,
  type ShipResult,
  STEP_TIMEOUT_MS,
  splitMessage,
  squashMessage,
  stepRun,
  takeMainIn,
  UNWATCHED,
} from "../git/land.ts";
import { withFetchLock, withRepoLock } from "../git/lock.ts";
import { logCommits, rangeSubjects, commitFiles as readCommitFiles } from "../git/log.ts";
import { aheadBehind, aheadUpstream, statusFiles, treeEmpty, treeFingerprint } from "../git/status.ts";
import { dropTurnRefs, markTurn } from "../git/turn.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { configFor, settingsLines } from "../repos/config.ts";
import { isInside } from "../repos/create.ts";
import { type RunHandle, RunService } from "../runs/service.ts";
import { allocateProxyPort, releasePort } from "../runtime/ports.ts";
import { DEFAULT_AGENT_ID, type Runtime, type RuntimeRegistry, worktreeEnv } from "../runtime/registry.ts";
import { type OwnWhy, resolveRun, spawnsOf } from "../runtime/run.ts";
import { runSetup } from "../runtime/setup.ts";
import {
  type ArchiveRecord,
  type ChatFiles,
  firstPrompt,
  lastUsage,
  move,
  summarize,
  WorktreeArchive,
} from "./archive.ts";
import { ArchivedGit } from "./archivedGit.ts";
import { changedFiles, touched } from "./backend.ts";
import type { ArtifactCache } from "./cache.ts";
import { discoverIn, type FoundWorktree } from "./discover.ts";
import type { FixService } from "./fix.ts";
import { type FillJob, fillLandMarks, unfilled } from "./landSubjects.ts";
import { branchSlug, cleanTitle, freeSlot, shortId, titleFrom } from "./naming.ts";
import { type ClaimStamps, SparePool } from "./spare.ts";
import { type TreeCore, TreeState } from "./treeState.ts";
import { mainOf, Trunk } from "./trunk.ts";
import { isUnseen } from "./turns.ts";

/** how often git's own list of a repo's worktrees is read when nothing has marked it stale */
const LIST_FLOOR_MS = 10_000;

/** Gitignored local config a worktree needs and git will never bring over. Absent secrets fail
 * deep inside app code rather than as missing config (an empty AUTH_SECRET reads as a zero-length
 * HMAC key), so copy whatever the base checkout actually has. */
const LOCAL_CONFIG_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars"];

/** names the block in info/exclude, so a later setup rewrites that one and leaves the rest */
const BASE_IGNORE = "base .gitignore";
/** how much of what a commit-msg hook printed the next message is written against: its last
 * lines, where the complaint is */
const REFUSAL_CHARS = 400;

/** what a grafted transcript keeps of a message: its text. The source's attachment store goes with
 * the source, so a stored ref would point at nothing, and a pick numbered in the source's session
 * would put the numbers the shell draws on chips out of step with the target session's own. */
/** a directory and everything under it, off the event loop; false when something in it refused */
async function deleteTree(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch (e) {
    log.warn("rm", `could not delete ${path}`, e);
    return false;
  }
}

function withoutAttachments(event: AgentEvent): AgentEvent {
  if (event.type !== "user-message" && event.type !== "handed") return event;
  const { attachments: _attachments, ...rest } = event;
  return rest;
}

/** Where a worktree id points, for work that only reads.
 *
 * Reading a worktree needs a directory and a branch to compare against, and nothing else, so a
 * worktree toyon did not create qualifies like any other. `wt` is present only when there is a
 * record, and it is what the handful of record-only behaviours key off: clearing `landed`, and
 * skipping ahead/behind on main, where HEAD is the default branch and the counts are zero by
 * definition. */
export interface ReadableWorktree {
  id: string;
  repoId: string;
  path: string;
  /** the title of a worktree toyon runs, the branch or directory name of one it found */
  name: string;
  /** absent when detached */
  branch?: string;
  /** another tool holds it (a live agent session); nothing here may write to it */
  locked?: boolean;
  defaultBranch: string;
  /** the ref every count, diff and sync here is against: main here, or origin's main where the
   * route lands work there (baseOf) */
  base: string;
  /** absent for a discovered worktree: there is nothing to mutate and nothing that owns it */
  wt?: WorktreeInfo;
}

/** what was typed into the chat of a worktree toyon is not running (an archived one, a found
 * one), sent once the worktree is toyon's to run */
export interface RestoreMessage {
  text: string;
  attachments?: AttachmentInput[];
  /** paragraphs Toyon attaches behind the text, out of the transcript */
  context?: string[];
}

export interface CreateOpts {
  /** the shell tab that asked; stored as createdBy so only that tab auto-focuses the result */
  createdBy?: string;
  /** registry id; the daemon's default when absent */
  agent?: string;
  /** paragraphs Toyon attaches behind the text, out of the transcript */
  context?: string[];
  /** in the order they were attached */
  attachments?: AttachmentInput[];
  /** what the agent may do without asking; the default mode when absent */
  mode?: PermissionMode;
  /** one of the agent's advertised model ids; its default when absent */
  model?: string;
  /** one of the agent's advertised effort levels; its default when absent */
  effort?: string;
  /** move main's uncommitted changes into the new worktree before its agent starts */
  carry?: boolean;
  /** the provisional row the message was typed in, which becomes the worktree in place */
  worktreeId?: string;
  /** the row's name from birth, when the caller already has one: no provisional title from the
   * prompt's first words, and the namer is never asked */
  title?: string;
  /** where the worktree came from, when it was made from somewhere: a piece names its origin */
  from?: WorktreeInfo["from"];
  /** born with a plan another agent wrote: written as the worktree's plan file before its agent
   * starts and set on the record. `prompt` is the first message once the file's path is known
   * (null when the tree would not take the file), sent in place of the one given, and recorded
   * as `handed` with these facts and the path beside it, never as the person's words. */
  plan?: { markdown: string; handed: Handed; prompt: (path: string | null) => string };
  /** made on an agent's proposal rather than typed into: its agent starts at once, its procs on
   * the first look at it or the first request for its preview, which the idle policy's wake edges
   * already are. A row the person typed into keeps its live preview, since the spare is warm. A
   * cold create never claims the spare: that row is the one the person types new work into, and
   * a claim would retitle it under their fingers and leave their draft in the proposal's box. */
  cold?: true;
}

/** what became of main's uncommitted files when a worktree was made from it */
interface Carried {
  branch: string;
  moved: boolean;
  /** main's uncommitted files before anything moved */
  count: number;
  /** a move was asked for and did not happen: the reason, for the person */
  unmoved?: string;
}

/** The first prompt says what the tree it starts in owes to main's working copy. An agent that
 * finds a dirty tree with no word about it commits it or cleans it up; one told main still has
 * files it cannot see will not hunt for them. */
function withCarry(context: string[] | undefined, c: Carried): string[] | undefined {
  if (c.count === 0) return context;
  const files = `${c.count} uncommitted ${c.count === 1 ? "file" : "files"}`;
  const line = c.moved
    ? `This worktree started with ${files} the person moved here from ${c.branch} by hand. They are part of the task, not something to clean up.`
    : `${c.branch} has ${files} the person chose to leave there. This worktree does not have them.`;
  return [...(context ?? []), line];
}

/** every row and trunk a frame carries numbers for */
const idsOf = (rows: readonly { id: string }[], trunks: Record<string, TrunkStatus>) => [
  ...rows.map((r) => r.id),
  ...Object.values(trunks).map((t) => t.id),
];

export interface WorktreeServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  paths: Paths;
  agents: AgentRegistry;
  /** the unsent text in composer boxes: a worktree discarded or deleted from the archive takes its
   * own, and a spare whose warm-up failed hands its words to the row that stands in for it */
  drafts?: Pick<DraftStore, "drop" | "move">;
  /** task → short kebab-case name (the worktree's own agent by default; tests inject a stub) */
  namer?: (prompt: string, wt: WorktreeInfo) => Promise<string | null>;
  /** the bytes a verdict was written about, as one string (git/status.ts treeFingerprint by
   * default; tests inject one they can hold) */
  fingerprint?: (path: string) => Promise<string>;
  /** a shell is subscribed to the worktree (server/interest.ts): the tree-state owner reads the
   * panel's tier for it and sends it frames */
  interested?: (id: string) => boolean;
  /** a tab shows the row (runtime/idle.ts): its tree is read ahead of rows nobody looks at */
  shown?: (id: string) => boolean;
  /** what earlier worktrees built to pass the check, cloned in ahead of the install */
  cache?: Pick<ArtifactCache, "restore">;
  /** a git step a landing runs, watched onto the worktree's transcript as the rows a `!` command
   * leaves (ExecService.watch): live while it runs long, whole when it fails */
  watch?: <T extends { exit: number | string | null; text: string; hook?: string }>(
    worktreeId: string,
    command: string,
    run: (onText: (text: string) => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T & { shown: boolean; toolId: string }>;
  /** the setup and commit runs as the rows carry them; the daemon shares one with the landing
   * service and the handlers, a test may leave it to the service */
  runs?: RunService;
  /** how a failure the agent can fix is sent to it */
  fix: Pick<FixService, "report">;
  /** what a worktree's preview page has thrown since it last loaded, as the paragraph a message
   * carries: a worktree made from a lead's box carries the lead's, since that is the preview the
   * person was looking at as they typed. Absent in tests. */
  pageErrors?: (worktreeId: string) => string | undefined;
}

/** a landing op's result as the service hands it on: `asked` when the agent was sent the turn that
 * fixes the failure, which the transcript then says in the line's place */
export type ShipOutcome = ShipResult & { asked?: true };

/** what a land op hands back: the result, `landed` when the work reached main and the row's word
 * is to be noted, and the mark it put on the record, so the word carries what landed. The mark
 * comes from the op and never from the record's last entry: a landing whose ref could not be kept
 * writes no mark, and the last entry would then be an earlier landing's. */
type Landed = {
  result: ShipResult;
  landed?: true;
  mark?: LandMark | undefined;
  /** the pull request the landing went through, for the row's word to link */
  url?: string | undefined;
  /** what kept the row's landed mark back after a landing that put the work on the base */
  held?: string | undefined;
};

/** the refusal for a found worktree another tool holds, with git's reason when it gave one */
const heldBy = (found: Pick<FoundWorktree, "name" | "lockReason">) =>
  `${found.name} is held by another tool${found.lockReason ? `: ${found.lockReason}` : ""}`;

/** the row's command as a person would have typed it: a plain word as is, anything else quoted.
 * A commit message shows its subject; the row is a record of what ran, not a line to paste. */
const commandLine = (args: string[]) =>
  args.map((a) => (/^[\w./:=@,+-]+$/.test(a) ? a : JSON.stringify(a.split("\n", 1)[0]))).join(" ");

export class WorktreeService {
  readonly spare: SparePool;
  /** the setup and commit runs out on each worktree: how long, what they are on, whether killed */
  readonly runs: RunService;
  /** the landing ops out, by the row or trunk each runs on: what every frame carries as the
   * row's `shipping`, and what holds a chat sent meanwhile. In memory only: an op does not
   * outlive the daemon, and what git was left mid-way is git's to report on the next press. */
  private ops = new Map<string, Shipping>();
  /** worktrees whose sync from main was pressed mid-turn on a dirty tree: it runs when the turn
   * ends, and a press meanwhile takes it back. In memory, like the ops: a turn does not outlive
   * the daemon either. */
  private syncQueued = new Set<string>();
  /** every project's main checkout as it stands, and how it follows origin */
  readonly trunk: Trunk;
  private archive: WorktreeArchive;
  /** archives under way, by worktree id: a click during a sweep joins the one already running */
  private archiving = new Map<string, Promise<ArchivedWorktree | null>>();
  /** restores under way, by archive id: a second press of restore, or a message typed into the
   * page meanwhile, joins the one already running. Let through, a second restore of the same id
   * checks out a second directory under the same record, or fails on the first's path and removes
   * it on the way out. */
  private restoring = new Map<string, Promise<WorktreeInfo>>();
  /** worktrees whose directory is being removed. A forced remove empties a big tree over seconds
   * and git answers honestly about a half-empty one, so a status read in that window reports every
   * file still in it as deleted: 15k of them on a 20k-file tree. Reads answer from the last counts
   * while an id is in here, and the row goes a moment later anyway. */
  private going = new Set<string>();
  /** rows listed ahead of their checkout: a restore puts the row and its chat on screen at the
   * press and checks the tree out behind them, so for a moment git has no directory to read */
  private arriving = new Set<string>();
  /** a claimed row's first message on its way to the agent's queue: a chat sent into the row
   * meanwhile goes behind it (settles either way, since the chat is not the claim's to refuse) */
  private firstPrompt = new Map<string, Promise<void>>();
  /** every row's badge numbers, read behind the frames rather than in them */
  /** the one reader of every row's git state: the rail's numbers and the panel's list come from it */
  readonly tree: TreeState;
  /** the HEAD each clean, level worktree was last asked about a hand landing at: one reflog read per move */
  private handChecked = new Map<string, string>();
  /** worktrees a name is being asked for: a turn that ends while the birth ask is still out does
   * not send a second one */
  private naming = new Set<string>();
  /** per repo, because discovery asks git once for the whole repo rather than once per worktree */
  private discoverCache = new Map<string, { rows: FoundWorktree[]; at: number }>();
  /** listings under way, by repo: a second ask for a repo being listed waits on that listing */
  private relisting = new Map<string, Promise<boolean>>();
  /** how many times the list was marked stale: a listing that began before a mark is for before it */
  private listMark = 0;
  /** the reads set off behind frames, with the frames they may send (see settled) */
  private pending = new Set<Promise<unknown>>();
  /** the last usage figures per worktree: live from the stream, else read once from the transcript
   * on disk (null: read, and there were none) */
  private usage = new Map<string, WorktreeStatus["usage"] | null>();

  constructor(private d: WorktreeServiceDeps) {
    d.hub.on("optionsLearned", (agentId, category, choices, runs) =>
      this.learnOptions(agentId, category, choices, runs),
    );
    this.runs = d.runs ?? new RunService({ state: d.state, hub: d.hub });
    this.archive = new WorktreeArchive(d.paths.archiveDir);
    this.trunk = new Trunk({
      state: d.state,
      hub: d.hub,
      counts: (main) => this.tree.counts(main.id),
      invalidateCounts: (mainId) => this.tree.invalidate(mainId),
    });
    this.tree = new TreeState({
      hub: d.hub,
      readable: (id) => this.readable(id),
      // on its way out, or its directory on its way in: a restore's checkout, or the pool's for a
      // reserved row and the task a claim made of it (the closure is read per call, so the pool
      // being built after the owner does not matter)
      going: (id) => this.going.has(id) || this.arriving.has(id) || this.spare.checkingOut(id),
      interested: (id) => d.interested?.(id) ?? false,
      shown: (id) => d.shown?.(id) ?? false,
      live: (id) => d.runtime.busy(id),
      trunkBehind: (mainId, path) => this.trunk.behind(mainId, path),
      prOpen: (id) => d.state.worktree(id)?.pr?.state === "open",
      afterCore: (r, core) => this.afterCore(r, core),
      rowsOf: (repoId) => this.rowsOf(repoId),
    });
    this.spare = new SparePool({
      state: d.state,
      hub: d.hub,
      runtime: d.runtime,
      paths: d.paths,
      runs: this.runs,
      setupAndStart: (wt, repo) => this.setupAndStart(wt, repo),
      teardown: (wt, repo) => this.teardown(wt, repo),
      prepare: async (wt, repo) => {
        await this.prepareProcs(wt, repo, spawnsOf(resolveRun(configFor(wt, repo), wt, repo.tier ?? {})), "setup");
      },
      discard: async (id) => {
        await this.discardWorktree(id);
      },
      carryDraft: (fromId, repoId) => {
        const main = this.mainOf(repoId);
        if (main) this.d.drafts?.move(fromId, main.id, true);
      },
      // main ran its page while it was the lead (the setup pane's preview, an empty project's);
      // the spare is the trunk's running page from here, so main's page stops rather than run
      // beside it, and main keeps only the shared tier the spare and every worktree reach on it
      ready: (repoId) => {
        const main = this.mainOf(repoId);
        if (!main) return;
        if (this.d.runtime.get(main.id)?.procs) {
          fireAndForget(main.id, this.d.runtime.stopPage(main.id), "main's page stops for the spare");
        }
        // what was typed or attached in main's box while it stood in (the spare warming, or one
        // that failed under someone's fingers) goes with the row: main's box is out of sight from here
        const spare = this.leadSpareOf(repoId);
        if (spare) this.d.drafts?.move(main.id, spare);
      },
    });
    d.hub.on("agent", (worktreeId, _seq, event) => {
      // the first file a parked worktree's agent writes is when its preview has something new to
      // show, and when the agent may want to look at it. A shell command does not count: a
      // question answered with `git log` is still a question.
      if (
        (event.type === "tool-start" || (event.type === "tool-update" && event.kind)) &&
        isWriteTool({ name: event.name ?? "", kind: event.kind })
      ) {
        this.startPreview(worktreeId);
      }
      if (event.type !== "usage") return;
      const { used, size, cost } = event;
      this.usage.set(worktreeId, { used, size, ...(cost !== undefined ? { cost } : {}) });
    });
    // turnSettled is emitted from inside the agentStatus dispatch, ahead of the ws layer's listener
    // on that event, so what is dropped here is gone before the status frame goes out
    d.hub.on("turnSettled", (worktreeId, turn) => {
      // The name asked for at birth can come back empty: the ask went out on an agent that could
      // not reach its API, or the answer was not a name. A turn that finished, or was stopped by
      // hand, ran on a live agent, so a row still on its placeholder is asked again, from the
      // words the task started with. A failed turn gets no ask, and neither does a turn waiting
      // on a card: that end comes once per card, and the finish after the answer asks. A worktree
      // on its way out stops its agent too; the ask would spawn another into a directory going.
      if ((turn.end === "done" || turn.end === "stopped") && !this.going.has(worktreeId)) {
        const wt = d.state.worktree(worktreeId);
        const prompt = wt?.unnamed ? firstAskOf(d.runtime.agentFor(worktreeId)?.transcript() ?? []) : undefined;
        if (wt && prompt) this.scheduleNaming(wt, prompt);
      }
      // A sync that waited for the turn runs now that the tree is still; an agent stopped asking
      // is mid-turn still, and resumes into the same tree once answered
      if (turn.end !== "asking") this.syncAfterTurn(worktreeId);
      // A proc that crashed or never answered gets another go once the agent has had a turn: the
      // boot pane's "ask the agent to fix it" ends here, and a fix nobody restarts after is not a
      // fix. A proc that is fine, or one you stopped yourself, is left alone, and so is one whose
      // agent is still mid-turn waiting on you.
      if (turn.end !== "done" && turn.end !== "stopped") return;
      for (const p of d.runtime.get(worktreeId)?.procs?.states() ?? []) {
        if (p.status !== "crashed" && p.status !== "unreachable") continue;
        d.hub.emit("log", worktreeId, p.name, "restarting after the agent's turn");
        fireAndForget(worktreeId, d.runtime.restartStream(worktreeId, p.name), "restart after turn");
      }
    });
  }

  // ---- create / remove / rename ----

  async create(repoId: string, prompt: string, opts: CreateOpts = {}): Promise<WorktreeInfo> {
    const { attachments } = opts;
    const repo = this.d.state.requireRepo(repoId);
    // the row the message was typed on: the provisional one, else main's. What its preview has
    // thrown goes with the first message when the worktree made is another row; the row itself
    // says it behind every message of its own.
    const lead = opts.worktreeId ?? this.d.state.worktrees.find((w) => w.repoId === repoId && isMain(w))?.id;
    const context = (id: string): string[] | undefined => {
      const threw = lead && lead !== id ? this.d.pageErrors?.(lead) : undefined;
      return threw ? [...(opts.context ?? []), threw] : opts.context;
    };
    // validated up front: an unknown or uninstalled agent is a refusal now, not a dead worktree later
    const agent = this.d.agents.require(opts.agent ?? this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id;
    // what the create names wins over what the composer picked for new worktrees of the agent
    const { model, effort } = this.d.state.fillPicks(agent, { model: opts.model, effort: opts.effort });
    // the repo's picks the same way
    const mode = opts.mode ?? repo.picks?.mode;
    // a message that is attachments alone is named from what they carry
    const task = taskText(prompt, attachments);
    // the title is the prompt's first words until the agent names it. The branch is born on the
    // directory's id and takes the title's slug with the name.
    const given = cleanTitle(opts.title ?? "") || undefined;
    const title = given ?? titleFrom(task);

    // fast path: claim the pre-warmed spare. Its runtime — agent included — already exists, so the
    // task's first message goes to the spare's agent. A cold create is a proposal's, not a send
    // from the row, so it takes a checkout of its own: the spare stays the person's, draft and all,
    // and a row meant to wait for a look does not arrive running.
    const spare = opts.cold ? undefined : this.d.state.worktrees.find((w) => w.repoId === repoId && w.kind === "spare");
    let carriedIn: Carried | undefined;
    let release: (() => void) | undefined;
    const stamps: ClaimStamps = {
      createdBy: opts.createdBy,
      // the spare's agent has no process yet; it reads the stamps on its first prompt
      agent,
      mode,
      model,
      effort,
      from: opts.from,
      // the claim stamped the prompt's words as a name still to be found; a given name is final
      unnamed: given ? undefined : (true as const),
    };
    const prepare = async (wt: WorktreeInfo) => {
      // the tree is there and the branch is not yet: main's changes come in, and the message
      // goes on a held queue, so the turn starts on the branch rather than commit to a detached
      // head. The spare's agent may be up already, warmed on the first keystroke under the
      // record's agent of the time; a task that asked for another gets that one.
      const rt = this.d.runtime.ensureAgent(wt);
      release = rt.agent.hold();
      if (rt.agent.runningAgent !== null && rt.agent.runningAgent !== agent) await rt.agent.restart();
      carriedIn = await this.carryMain(repo, wt, !!opts.carry);
      const born = this.bornWith(wt, opts.plan);
      rt.agent.send(born?.text ?? prompt, {
        context: withCarry(context(wt.id), carriedIn),
        attachments,
        ...(born ? { handed: born.handed } : {}),
      });
    };
    const claimed = spare ? await this.spare.claim(repoId, title, opts.worktreeId, stamps, prepare) : null;
    if (claimed) {
      const { wt } = claimed;
      const rt = this.d.runtime.ensureAgent(wt);
      // a chat into the row meanwhile waits for the branch, behind the first message queued
      // ahead of it; it never waits on the claim's outcome, which is not its to refuse
      this.firstPrompt.set(
        wt.id,
        claimed.settled.then(
          () => undefined,
          () => undefined,
        ),
      );
      // the frame that moves the row on every screen, now that a message sent into it on sight
      // has an agent to queue on and a first message to wait behind
      this.d.hub.emit("worktreesChanged");
      try {
        await claimed.settled;
      } catch (e) {
        // the row is a spare again by now: the message leaves the queue and goes back to the box
        if (carriedIn && rt.agent.queueLength > 0) rt.agent.unqueue(0);
        release?.();
        throw e instanceof UserError ? e : new UserError(e instanceof Error ? e.message : String(e));
      } finally {
        this.firstPrompt.delete(wt.id);
      }
      release?.();
      await this.nameOrAsk(wt, task, given);
      if (carriedIn?.unmoved) throw new UserError(carriedIn.unmoved, { delivered: true });
      return wt;
    }

    // A checkout that git stops treating as one (`core.bare` set in the config its worktrees share)
    // fails every step below with git's own words, after the worktree exists and before its message
    // is sent. Refused here, nothing is made. The claim above needs no such check: its switch
    // fails with git's words before anything changes, and the spare goes back to the pool.
    if (!(await isGitRepo(repo.path))) {
      throw new UserError(
        `git no longer reads ${repo.name} as a checkout, so there is nothing to start a worktree from. If \`git config core.bare\` says true there, \`git config --unset core.bare\` puts it back.`,
      );
    }
    const { id, dir } = freeSlot(join(this.d.paths.worktreesDir, repo.name));
    const wtPath = join(this.d.paths.worktreesDir, repo.name, dir);
    const branch = `toyon/${dir}`;
    // born on the base, which under a remote base is a remote-tracking ref: --no-track, or git
    // would set the new branch's upstream to origin/main and a push of it would go there
    await withRepoLock(repo.path, () =>
      gitOrThrow(repo.path, "worktree", "add", "--no-track", "-b", branch, wtPath, baseOf(repo)),
    );

    const wt: WorktreeInfo = {
      id,
      repoId,
      path: wtPath,
      branch,
      kind: "worktree",
      proxyPort: await allocateProxyPort(),
      title,
      ...(given ? {} : { unnamed: true }),
      createdAt: Date.now(),
      // made from a prompt, which is a send
      promptedAt: Date.now(),
      agent,
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    // before the setup reads the tree and before the agent's first look at it
    const carried = await this.carryMain(repo, wt, !!opts.carry);
    // setup + procs warm in the background; the agent starts immediately. A proposed worktree
    // sets up and then waits for a look: nobody is watching its preview yet
    this.launch(wt, repo, repo.path, opts.cold ? { start: false } : {});
    const born = this.bornWith(wt, opts.plan);
    this.d.runtime.ensureAgent(wt).agent.send(born?.text ?? prompt, {
      context: withCarry(context(id), carried),
      attachments,
      ...(born ? { handed: born.handed } : {}),
    });
    await this.nameOrAsk(wt, task, given);
    if (carried.unmoved) throw new UserError(carried.unmoved, { delivered: true });
    return wt;
  }

  /** A worktree born with a plan another agent wrote: the plan is its file before the agent's
   * first look, and the record names it so the composer's line and the pane read it as any
   * approved plan. What the first message records rides back with the path. A write the tree
   * refuses leaves the pointer naming no file; the agent is told as much by the prompt. */
  private bornWith(wt: WorktreeInfo, plan: CreateOpts["plan"]): { text: string; handed: Handed } | null {
    if (!plan) return null;
    const path = writePlanDocNow(wt.path, plan.markdown);
    if (path) {
      const live = this.d.state.requireWorktree(wt.id);
      live.plan = path;
      live.planned = true;
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
    }
    return { text: plan.prompt(path), handed: { ...plan.handed, ...(path ? { path } : {}) } };
  }

  /** the branch follows the title: a title given at birth moves it now, as the namer's answer
   * would have, and the namer is never asked; without one the namer is. The move is awaited, so
   * the branch create returns is the one the worktree keeps: a handoff copies it into the `after`
   * of the siblings queued behind it, and a copy made before the move would name a branch that is
   * gone. A provisional title is the namer's to move later, off this call, so a record that has to
   * hold through that keeps the id alone (`awaits`). */
  private async nameOrAsk(wt: WorktreeInfo, task: string, given: string | undefined) {
    if (given === undefined) {
      this.scheduleNaming(wt, task);
      return;
    }
    try {
      await this.rename(wt.id, given);
    } catch (e) {
      // the title is on the row either way; a branch git would not move stays where it is
      log.warn(wt.id, "branch for the given title", e);
    }
  }

  /** What became of main's uncommitted work when a worktree was made from it. Asked to `move`, the
   * stash takes the changes (untracked files included) and clears main in one git step, so an edit
   * saved on main in the meantime is either in it or still on main, never lost between a read and a
   * clean; the stash is applied in the new worktree and dropped. A stash that will not apply goes
   * back onto main, which it came off cleanly, and the worktree starts without it, with `unmoved`
   * saying why for the person. Not asked to move, the files are only counted, so the agent can be
   * told they were left behind on purpose. */
  private async carryMain(repo: RepoInfo, wt: WorktreeInfo, move: boolean): Promise<Carried> {
    // the worktree exists by now and its first message goes out after this: what main holds is
    // context for that message, so failing to read it costs the context and never the message
    try {
      return await this.carryMainOrThrow(repo, wt, move);
    } catch (e) {
      log.warn(wt.id, `reading ${repo.defaultBranch}'s changes failed`, e);
      const unmoved = move ? `the changes on ${repo.defaultBranch} could not be read, so they stayed there` : undefined;
      return { branch: repo.defaultBranch, moved: false, count: 0, ...(unmoved ? { unmoved } : {}) };
    }
  }

  private async carryMainOrThrow(repo: RepoInfo, wt: WorktreeInfo, move: boolean): Promise<Carried> {
    const main = repo.defaultBranch;
    // left behind, so only a number for the agent: the rail's count of main, at most a few seconds
    // old, rather than a status of the whole checkout between enter and the message showing
    if (!move) {
      const count = this.tree.counts(this.mainOf(repo.id)?.id ?? "")?.dirty ?? 0;
      return { branch: main, moved: false, count };
    }
    let count = 0;
    const unmoved = await withRepoLock(repo.path, async (): Promise<string | undefined> => {
      count = (await statusFiles(repo.path)).length;
      if (count === 0) return undefined;
      const before = await git(repo.path, "rev-parse", "-q", "--verify", "refs/stash");
      const pushed = await git(repo.path, "stash", "push", "--include-untracked", "-m", `toyon: into ${wt.title}`);
      if (!pushed.ok) return `the changes on ${main} could not be moved: ${pushed.err.trim()}`;
      const after = await git(repo.path, "rev-parse", "-q", "--verify", "refs/stash");
      const sha = after.out.trim();
      // nothing was taken after all (ignored files only), so nothing needs putting anywhere
      if (!after.ok || (before.ok && before.out.trim() === sha)) return undefined;
      // stash drop and pop take stash@{n}, never a sha, and a stash pushed outside toyon in the
      // meantime would move ours down the list
      const entry = async () => {
        const list = await git(repo.path, "stash", "list", "--format=%H");
        const i = list.out.split("\n").indexOf(sha);
        return i < 0 ? null : `stash@{${i}}`;
      };
      // read before the apply, because after it they exist either way: the stash's own untracked
      // files (its third parent) that this worktree does not already have. Undoing a half-applied
      // stash is those paths and the tracked reset, and nothing else. A blanket `clean -fd` here
      // took a claimed spare's node_modules and everything its setup wrote with it, and in a
      // worktree whose branch has no .gitignore it took every ignored file in the tree.
      const carried = await gitRaw(repo.path, "ls-tree", "-r", "-z", "--name-only", `${sha}^3`);
      const restored = (carried.ok ? nulSplit(carried.out) : []).filter((p) => !existsSync(join(wt.path, p)));
      const applied = await git(wt.path, "stash", "apply", sha);
      if (applied.ok) {
        const ref = await entry();
        if (ref) await git(repo.path, "stash", "drop", ref);
        return undefined;
      }
      log.warn(wt.id, `moving ${main}'s changes failed`, applied.err);
      await git(wt.path, "reset", "--hard");
      // literal pathspecs, so a file named with a `*` is that file; in chunks, because a pathspec
      // list is argv and main's uncommitted set has no bound
      for (let i = 0; i < restored.length; i += 100) {
        await git(wt.path, "--literal-pathspecs", "clean", "-fd", "--", ...restored.slice(i, i + 100));
      }
      const ref = await entry();
      const back = ref ? await git(repo.path, "stash", "pop", ref) : null;
      return back?.ok
        ? `the changes on ${main} did not apply in ${wt.title}, so they stayed on ${main}`
        : `the changes on ${main} did not apply in ${wt.title}; they are kept in git stash as "toyon: into ${wt.title}"`;
    });
    // main's count where it is known, since the next task born from here reads it before any frame
    // has it read again; the rest of main's numbers follow
    const mainWt = this.mainOf(repo.id);
    if (mainWt) {
      await this.tree.refresh(mainWt.id);
    }
    return { branch: main, moved: count > 0 && !unmoved, count, unmoved };
  }

  /** the record goes in, the rail hears about it, and the slow part (a deps clone, setup
   * commands, the procs) runs behind; RuntimeRegistry.start emits worktreesChanged again once the
   * procs are up. The one step create, take-over and opening a ref all share. */
  private launch(
    wt: WorktreeInfo,
    repo: RepoInfo,
    depsSource: string,
    opts: { setupCommands?: boolean; start?: boolean } = {},
  ) {
    this.d.state.addWorktree(wt);
    this.d.hub.emit("worktreesChanged");
    fireAndForget(wt.id, this.setupAndStart(wt, repo, depsSource, opts), "setup + start");
  }

  /** Open a branch, a remote branch or a PR as a worktree toyon owns. Not a task: no prompt goes
   * anywhere, and the agent comes up on the first message. Unlike take-over the directory is
   * toyon's own, so the repo's setup commands run. */
  async openRef(
    repoId: string,
    kind: RefKind,
    ref: string,
    opts: { createdBy?: string; pr?: { title: string; url: string } } = {},
  ): Promise<WorktreeInfo> {
    const repo = this.d.state.requireRepo(repoId);
    const agent = this.d.agents.require(this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id;
    const number = kind === "pr" ? Number.parseInt(ref, 10) : Number.NaN;
    if (kind === "pr" && !(number > 0)) throw new UserError("that is not a PR number");
    const branch = kind === "pr" ? `pr/${number}` : ref;
    // the branch is the person's, so it is what the row says it is, and the directory takes its
    // slug rather than a wt-xxxx id: a branch checked out by name is never renamed by toyon, so a
    // directory named for it stays true, where a task's directory would outlive its first name
    const title = kind === "pr" ? `pr-${number}` : cleanTitle(ref) || "branch";
    let slug = branchSlug(title) || "branch";
    if (existsSync(join(this.d.paths.worktreesDir, repo.name, slug))) slug = `${slug}-${shortId().slice(0, 4)}`;
    const wtPath = join(this.d.paths.worktreesDir, repo.name, slug);

    await withRepoLock(repo.path, async () => {
      const out = (await listWorktrees(repo.path)).find((w) => w.branch === branch);
      if (out) throw new UserError(`${branch} is already checked out at ${out.path}`);
      if (kind === "branch") {
        await gitOrThrow(repo.path, "worktree", "add", wtPath, ref);
      } else if (kind === "remote") {
        await gitOrThrow(repo.path, "worktree", "add", "--track", "-b", ref, wtPath, `origin/${ref}`);
      } else {
        // the base repo exposes every PR's head under refs/pull, fork or not, so no second remote
        // is needed; a credential prompt would hang a daemon, so it fails instead
        const f = await run(
          GIT,
          ["fetch", "origin", `+refs/pull/${number}/head:refs/heads/${branch}`],
          repo.path,
          NO_PROMPT,
        );
        if (!f.ok) throw new UserError(`could not fetch PR #${number}: ${f.err.slice(-200)}`);
        await gitOrThrow(repo.path, "worktree", "add", wtPath, branch);
      }
    });

    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: wtPath,
      branch,
      kind: "worktree",
      proxyPort: await allocateProxyPort(),
      title,
      createdAt: Date.now(),
      agent,
      ...this.d.state.fillPicks(agent, {}),
      from: {
        kind,
        ref,
        ...(kind === "pr" ? { pr: { number, title: opts.pr?.title ?? "", url: opts.pr?.url ?? "" } } : {}),
      },
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    };
    this.launch(wt, repo, repo.path);
    return wt;
  }

  /** The discovered row at this path as it stands right now, or a refusal.
   *
   * Re-derived rather than read from the cache because the frame the person clicked can be
   * seconds old, and a lock is the only thing standing between us and another agent's working
   * directory: it must still be on the list the daemon would push. */
  private async requireDiscovered(
    repoId: string,
    repoPath: string,
    target: string,
    except?: string,
  ): Promise<FoundWorktree> {
    // a record listed ahead of this check holds the path it is checking, and must not hide it
    const known = this.d.state.worktrees.filter((w) => w.id !== except);
    const rows = await discoverIn(repoId, repoPath, known);
    const found = rows.find((r) => canonical(r.path) === target);
    if (!found) throw new UserError("that worktree is gone, or Toyon already has it");
    return found;
  }

  /** Promote a worktree git knows about into one toyon runs.
   *
   * The directory already exists and someone else made it, so this allocates a port and records
   * it, parked: a dev server in a directory the person made is theirs to ask for (see
   * `startPreview`). It deliberately does not run the settings' setup commands (see
   * `setupAndStart`). Take-over is not a task, so the agent comes up on the first message like it
   * does anywhere else; a `message` typed into the found row's chat is that message.
   *
   * The record is listed first, from the list as last pushed, and git's own list is read under
   * the lock behind it, the way a restore lists its row ahead of the checkout: the message reads
   * as sent and the row takes the found one's place at the press, and the wait for the lock,
   * seconds behind a landing, is read through on the live page. A directory that went, or was
   * locked by another tool, since the list was pushed is found out under the lock and the record
   * goes again, with the message handed back. */
  async adopt(worktreeId: string, createdBy?: string, message?: RestoreMessage): Promise<WorktreeInfo> {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("that worktree is gone");
    if (r.wt) throw new UserError(`Toyon already runs ${r.name}`);
    const repoId = r.repoId;
    const repo = this.d.state.requireRepo(repoId);
    const target = canonical(r.path);
    // what the pushed list already says is refused before anything is listed
    const pushed = this.discoveredById(worktreeId);
    if (pushed?.locked) throw new UserError(heldBy(pushed));
    // land, ship, merge and rename all address a branch; a detached worktree has none to name
    if (!r.branch) throw new UserError(`${r.name} is detached: check out a branch in it first`);
    // procs and a dep clone inside the main checkout would land in its working tree, where the
    // agent's file tools and git status would both start seeing them
    const enclosing = [...this.d.state.repos, ...this.d.state.worktrees].find((w) =>
      isInside(target, canonical(w.path)),
    );
    if (enclosing) throw new UserError(`${r.name} sits inside ${enclosing.path}, which Toyon already manages`);
    const agent = this.d.agents.require(this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id;
    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: r.path,
      branch: r.branch,
      kind: "worktree",
      proxyPort: await allocateProxyPort(),
      title: r.name,
      createdAt: Date.now(),
      agent,
      ...this.d.state.fillPicks(agent, {}),
      parked: true,
      ...(message ? { promptedAt: Date.now() } : {}),
      ...(createdBy ? { createdBy } : {}),
    };
    const { rt, release } = this.listAhead(wt, message);
    // the found row leaves the list as the record takes its path
    this.invalidateDiscovered();
    this.d.hub.emit("worktreesChanged");
    try {
      // under the lock, so this cannot race a `worktree remove` and keep a record pointing at a
      // directory that is already gone
      await withRepoLock(repo.path, async () => {
        const found = await this.requireDiscovered(repoId, repo.path, target, wt.id);
        if (found.locked) throw new UserError(heldBy(found));
        if (!found.branch) throw new UserError(`${found.name} is detached: check out a branch in it first`);
        // the branch as git has it now, should it have moved since the list was pushed
        wt.branch = found.branch;
      });
    } catch (e) {
      await this.unlist(wt, !!message);
      this.invalidateDiscovered();
      this.d.hub.emit("worktreesChanged");
      throw e;
    }
    this.d.state.save();
    // slow, and nothing above depends on it: outside the lock, like create()'s own setup
    fireAndForget(wt.id, this.setupAndStart(wt, repo, repo.path, { setupCommands: false }), "setup + start");
    // the word on the take-over opens the transcript, the way a restore's picks one up
    rt.agent.note({ type: "adopted", branch: wt.branch, ts: Date.now() });
    release();
    return wt;
  }

  /** Run the named shared-tier procs here rather than reaching main's; every borrowed one when
   * `names` is absent. Each proc's own setup runs first, on its tab, while the page keeps reaching
   * main's; the record says so only once that setup is through, so a setup that fails leaves the
   * proc main's with a word on why, and a daemon that dies mid-setup leaves nothing half owned
   * (the next edit signal runs the check again). `why` is who asked: it is written on the record
   * and said on the transcript. */
  async ownProcs(worktreeId: string, names?: string[], why: OwnWhy = { by: "hand" }): Promise<void> {
    const { wt, repo } = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (wt.kind === "main") throw new UserError("main runs the shared tier for everyone already");
    const run = this.d.runtime.runOf(wt.id) ?? resolveRun(configFor(wt, repo), wt, repo.tier ?? {});
    const pointed = (names ?? []).find((n) => n in run.pointed);
    if (pointed) {
      throw new UserError(
        `${pointed} points at ${remoteOf(wt.sources?.[pointed]?.at)} here; move it back to main first`,
      );
    }
    const take = (names ?? run.borrowed).filter((n) => run.borrowed.includes(n));
    if (take.length === 0) throw new UserError("nothing here runs on main");
    const { ready, failed } = await this.prepareProcs(wt, repo, take, "tab");
    if (ready.length > 0) {
      const file = why.by === "edit" ? ready.map((n) => why.files[n]).find(Boolean) : undefined;
      for (const n of ready) {
        const at: Owned = { by: why.by, ...(why.by === "edit" && why.files[n] ? { file: why.files[n] } : {}) };
        this.setSource(wt, n, { at });
      }
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      this.d.runtime
        .get(wt.id)
        ?.agent.note({ type: "owned", names: ready, by: why.by, ...(file ? { file } : {}), ts: Date.now() });
      await this.d.runtime.own(wt.id, ready);
    }
    // the hand path reads the failure as a toast; the flip and the tool read the transcript
    if (failed && why.by === "hand") throw new UserError(failed);
  }

  /** The named procs' own setup, for those that have one and have not run it here, in run order,
   * each command under the setup ceiling with the worktree's variables and on the row as a setup
   * stage. `sink` is where the output goes: the `setup` stream at birth, when no proc has a tab
   * yet, or the proc's own tab at a flip, where the proc stands `preparing` with the step as its
   * detail until it spawns. A proc whose setup fails is not prepared and is not started: at a
   * flip it stays main's, at birth it is left for the person to read, and the line that says so
   * goes where the output went and onto the transcript. Returns what is ready to run, and the
   * first failure's line. */
  private async prepareProcs(
    wt: WorktreeInfo,
    repo: RepoInfo,
    names: string[],
    sink: "setup" | "tab",
  ): Promise<{ ready: string[]; failed?: string }> {
    // the worktree's own file: its commands carry their setup
    const { config } = configFor(wt, repo);
    const ceiling = timeoutFor(config, "setup");
    const ready: string[] = [];
    let failed: string | undefined;
    for (const name of names) {
      const entry = config.run[name];
      if (entry === undefined) continue;
      const cmds = procSetup(entry);
      if (cmds.length === 0 || wt.sources?.[name]?.prepared) {
        ready.push(name);
        continue;
      }
      const toTab = sink === "tab";
      const say = (line: string) => {
        if (toTab) this.d.runtime.setupOutput(wt.id, name, `${line}\r\n`);
        else this.d.hub.emit("log", wt.id, "setup", line);
      };
      let broke: string | undefined;
      for (const cmd of cmds) {
        if (toTab) this.d.runtime.preparing(wt.id, name, runCmd(entry), `setup: ${cmd}`);
        const run = this.runs.begin(wt.id, "setup", { timeoutMs: ceiling, stage: `${name}: ${cmd}` });
        const code = await runSetup(
          cmd,
          wt.path,
          (line, retract) => {
            if (!toTab) this.d.hub.emit("log", wt.id, "setup", line, retract);
          },
          worktreeEnv(wt, repo),
          {
            timeoutMs: ceiling,
            onSpawn: run.spawned,
            ...(toTab ? { onData: (data: string) => this.d.runtime.setupOutput(wt.id, name, data) } : {}),
          },
        );
        run.finish(code);
        if (code === 0) continue;
        broke =
          code === "timeout"
            ? `${name} setup gave up after ${describeDuration(ceiling)}: ${cmd}`
            : `${name} setup failed (exit ${code}): ${cmd}`;
        say(toTab ? `${broke}; the page still reaches main's ${name}` : broke);
        this.d.runtime.get(wt.id)?.agent.note({ type: "own-failed", name, cmd, exit: code, ts: Date.now() });
        break;
      }
      if (broke) {
        failed ??= broke;
        if (toTab) await this.d.runtime.unprepare(wt.id, name);
        continue;
      }
      this.setSource(wt, name, { prepared: true });
      this.d.state.save();
      ready.push(name);
    }
    return { ready, ...(failed ? { failed } : {}) };
  }

  /** the named shared-tier procs this worktree ran itself stop, and main's are reached again;
   * every owned one when `names` is absent. What their setup made here stays made, so a later
   * take-over skips it. */
  async shareProcs(worktreeId: string, names?: string[]): Promise<void> {
    const { wt } = this.d.state.requireWorktreeWithRepo(worktreeId);
    const owned = Object.entries(wt.sources ?? {})
      .filter(([, src]) => ownedBy(src.at))
      .map(([n]) => n);
    const drop = (names ?? owned).filter((n) => owned.includes(n));
    if (drop.length === 0) throw new UserError("nothing here runs its own copy of the shared tier");
    for (const n of drop) this.setSource(wt, n, { at: undefined });
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    await this.d.runtime.share(wt.id);
  }

  /** Procs and proxy come back under the worktree's record; the agent is untouched. A wake rather
   * than a start, so a record changed while setup still runs (a claimed spare's, or the seconds
   * after a cold create) starts nothing on a tree with no deps: the start at the end of setup
   * reads the record. */
  private restartProcs(wt: WorktreeInfo) {
    fireAndForget(
      wt.id,
      this.d.runtime.stopProcs(wt.id).then(() => this.d.runtime.wake(wt.id)),
      "point restart",
    );
  }

  /** one proc's entry on the record, merged; an entry with nothing left in it goes, and so does
   * the map. `at: undefined` in the patch clears the source. A hold is main's alone: a patch that
   * sets `at` ends it, and a later move back to main's records a new one. */
  private setSource(wt: WorktreeInfo, name: string, patch: Partial<ProcSource>) {
    const next: ProcSource = { ...wt.sources?.[name], ...patch };
    if (next.at === undefined) delete next.at;
    else if (patch.at !== undefined) delete next.held;
    if (!next.prepared) delete next.prepared;
    if (!next.held?.length) delete next.held;
    const sources = { ...wt.sources };
    if (Object.keys(next).length === 0) delete sources[name];
    else sources[name] = next;
    if (Object.keys(sources).length === 0) delete wt.sources;
    else wt.sources = sources;
  }

  /** Where this worktree's page reaches one shared proc: main's, its own, or one of the proc's
   * remotes. Its own runs its setup first and starts beside the page (ownProcs); main's stops what
   * ran here and reaches main's again, what its setup made kept; a remote is a pick that wins over
   * the flip, with the proc neither run here nor borrowed and the worktree's procs restarted for
   * the address, since the addresses are spawn-time env. Moving from a remote to its own runs the
   * setup where the birth setup would, then restarts the procs with it among them. */
  async setProcSource(worktreeId: string, name: string, source: "main" | "here" | { remote: string }): Promise<void> {
    const { wt, repo } = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (wt.kind === "main") throw new UserError("main runs its own procs; move a worktree's instead");
    // the worktree's own file names its commands and their remotes
    const { config, file } = configFor(wt, repo);
    const entry = config.run[name];
    if (entry === undefined) throw new UserError(`no "${name}" in ${file}`);
    const at = wt.sources?.[name]?.at;
    const remote = remoteOf(at);
    if (typeof source === "object") {
      if (!(source.remote in runRemotes(entry))) {
        throw new UserError(`"${name}" has no remote "${source.remote}" in ${file}`);
      }
      if (remote === source.remote) return;
      this.setSource(wt, name, { at: { remote: source.remote } });
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      this.restartProcs(wt);
      return;
    }
    if (source === "main") {
      if (remote === undefined && !ownedBy(at)) return;
      // the pick is made knowing the files that touch the proc as they stand, so the check does
      // not flip it back on them; written before the procs move, since the first one coming up
      // runs the check
      const held = await this.touchedNow(wt, repo, name);
      this.setSource(wt, name, { held });
      if (remote === undefined) {
        await this.shareProcs(worktreeId, [name]);
        return;
      }
      this.setSource(wt, name, { at: undefined });
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      this.restartProcs(wt);
      return;
    }
    if (remote === undefined) {
      if (!ownedBy(at)) await this.ownProcs(worktreeId, [name]);
      return;
    }
    const { failed } = await this.prepareProcs(wt, repo, [name], "setup");
    if (failed) throw new UserError(failed);
    this.setSource(wt, name, { at: { by: "hand" } });
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    this.restartProcs(wt);
  }

  /** the worktree's changed files, committed ahead of main included, that would flip the named
   * shared proc here now: what the check reads, read the same way */
  private async touchedNow(wt: WorktreeInfo, repo: RepoInfo, name: string): Promise<string[]> {
    const tier = repo.tier?.[name];
    if (!tier) return [];
    return touched(await changedFiles(wt, repo, true), tier.paths);
  }

  /** The shared tier as it stands for one worktree, for the paragraph behind every message: each
   * shared proc with who runs it for this page, what flips it, why it runs here when it does, and
   * main's state of what is borrowed. Null for main, a spare, an unconfirmed repo or a repo with
   * nothing shared. */
  tierStanding(worktreeId: string): TierStanding | null {
    const wt = this.d.state.worktree(worktreeId);
    const repo = wt && this.d.state.repo(wt.repoId);
    if (!wt || !repo || wt.kind !== "worktree" || repo.needsSetup) return null;
    const run = this.d.runtime.runOf(wt.id) ?? resolveRun(configFor(wt, repo), wt, repo.tier ?? {});
    if (run.shared.length === 0) return null;
    const behind = new Set(this.d.runtime.remoteBehind(wt.id));
    const borrowed = new Map(this.d.runtime.borrowedStates(wt.id).map((b) => [b.name, b.status]));
    const own = new Map((this.d.runtime.get(wt.id)?.procs?.states() ?? []).map((p) => [p.name, p.status]));
    const main = this.mainOf(repo.id);
    const mainDirty = main ? (this.tree.counts(main.id)?.dirty ?? 0) : 0;
    const procs = run.shared.map((name): TierProcStanding => {
      const tier = repo.tier?.[name] ?? { paths: [] };
      const source: TierProcStanding["source"] =
        name in run.pointed
          ? { remote: remoteOf(wt.sources?.[name]?.at) ?? "", url: run.pointed[name]! }
          : run.borrowed.includes(name)
            ? "main"
            : "here";
      const status = source === "main" ? borrowed.get(name) : source === "here" ? own.get(name) : undefined;
      return {
        name,
        source,
        paths: tier.paths,
        ...(ownedBy(wt.sources?.[name]?.at) ? { reason: ownedBy(wt.sources?.[name]?.at) } : {}),
        ...(behind.has(name) ? { behind: true as const } : {}),
        ...(status ? { status } : {}),
        // its own setup is running here while the record still says main's
        ...(source === "main" && own.get(name) === "preparing" ? { preparing: true as const } : {}),
      };
    });
    return { procs, mainDirty };
  }

  /** what the agent may do here without asking. Nothing restarts: the session reads the record
   * before every permission request, and an agent that is up is told the mode now, so it holds
   * for the turn already running as well as the next prompt. */
  setMode(worktreeId: string, mode: PermissionMode) {
    if (!this.d.state.setMode(worktreeId, mode)) return;
    this.d.hub.emit("worktreesChanged");
    this.d.runtime.agentFor(worktreeId)?.modeChanged();
  }

  /** which of its models the agent runs here, from the next turn on. An empty id means its own
   * default. Not checked against a list here: a record is a request, and the session applies it
   * against the list of the agent that actually runs, following an id the adapter has since
   * renamed and saying so in the chat when the model is gone. */
  setModel(worktreeId: string, model: string) {
    this.setOption(worktreeId, "model", model);
  }

  /** An agent's list for a category as a session or a check just read it (the hub's
   * `optionsLearned`): cached per agent, so the picker on a worktree whose session has not opened
   * yet shows what the agent offered last time. No record is held to it: the list is one process's
   * answer, and two builds of the same agent spell their ids differently. */
  learnOptions(agentId: string, category: OptionCategory, choices: ModelChoice[], runs?: string) {
    if (this.d.state.setCachedOptions(agentId, category, choices, runs)) this.d.hub.emit("agentsChanged");
  }

  /** the effort level, the same way; its choices depend on the model, and one the model has not
   * got is left alone by the session rather than refused here */
  setEffort(worktreeId: string, effort: string) {
    this.setOption(worktreeId, "effort", effort);
  }

  private setOption(worktreeId: string, field: OptionField, value: string) {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (wt.kind === "spare") throw new UserError(`no ${field} for a spare worktree`);
    const next = value || undefined;
    if (wt[field] === next) return;
    if (next) wt[field] = next;
    else delete wt[field];
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** async pretty-naming: the agent's quick model names the task, and the branch follows the title */
  private scheduleNaming(wt: WorktreeInfo, prompt: string) {
    // nothing to name from: the slug stays rather than a name made up from an empty task
    if (!prompt.trim()) return;
    if (this.naming.has(wt.id)) return;
    this.naming.add(wt.id);
    const asked = (this.d.namer ?? makeNamer(this.d.runtime))(prompt, wt);
    const applied = asked.then((name) => {
      if (name) return this.rename(wt.id, name);
    });
    fireAndForget(
      wt.id,
      applied.finally(() => this.naming.delete(wt.id)),
      "auto-naming",
    );
  }

  /** Archive a worktree: its runtime, its directory, its branch when the branch is toyon's, and its
   * record go, and its chat moves to the archive with the commits and uncommitted work kept under a
   * ref, so an archive can be undone and a landed branch's conversation brought back. Its draft
   * stays, under the same id. One archive per worktree at a time: a second caller waits on the
   * first and gets its answer. `reason` is why it archived itself, when nobody asked. Returns what
   * was archived, if anything. */
  archiveWorktree(worktreeId: string, opts: { reason?: string } = {}): Promise<ArchivedWorktree | null> {
    const running = this.archiving.get(worktreeId);
    if (running) return running;
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || !canArchive(wt)) return Promise.resolve(null);
    const done = this.takeDown(wt, true, opts.reason).finally(() => this.archiving.delete(worktreeId));
    this.archiving.set(worktreeId, done);
    return done;
  }

  /** the archive a worktree is on its way into, while one is under way */
  archivingNow(worktreeId: string): Promise<ArchivedWorktree | null> | undefined {
    return this.archiving.get(worktreeId);
  }

  /** Remove a worktree and keep nothing: a spare holds nobody's work, and a grafted source's
   * history already lives in its target. */
  async discardWorktree(worktreeId: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || !(canArchive(wt) || wt.kind === "spare")) return;
    await this.takeDown(wt, false);
    this.d.drafts?.drop(worktreeId);
  }

  /** Marked as going for the whole of it, reads included: `archiving` covers a click during a
   * sweep, and a discard is not in it at all. */
  private async takeDown(wt: WorktreeInfo, archive: boolean, reason?: string): Promise<ArchivedWorktree | null> {
    this.going.add(wt.id);
    // before the agent is stopped: its stop settles the turn, and a sync waiting on that would
    // run in the directory on its way out
    this.syncQueued.delete(wt.id);
    try {
      return await this.removeAndRecord(wt, archive, reason);
    } finally {
      this.going.delete(wt.id);
    }
  }

  private async removeAndRecord(wt: WorktreeInfo, archive: boolean, reason?: string): Promise<ArchivedWorktree | null> {
    const worktreeId = wt.id;
    const repo = this.d.state.requireRepo(wt.repoId);
    // the agent first (inside runtime.stop): it may be mid-turn in the directory about to be
    // deleted, and its session-info callback would re-add the session entry removed below
    await this.d.runtime.stop(worktreeId);
    await this.teardown(wt, repo);
    const kept = await withRepoLock(repo.path, async () => {
      // before the directory goes: its uncommitted work exists nowhere else. Nothing kept means
      // nothing goes: the branch is deleted on the strength of the ref holding its commits, and a
      // sweep runs with nobody watching, so the row stays and says why. The runtime is already
      // down, which is what an idle row looks like; a look at it wakes it.
      const k = archive ? await this.keep(repo, wt) : null;
      if (archive && !k) throw new UserError(`could not keep ${wt.title}'s work, so it was left in place`);
      // the plans are kept out of git, so the snapshot has none of them; they leave with the chat
      if (archive) this.keepPlans(wt);
      try {
        await this.removeDirectory(repo, wt);
      } catch (e) {
        rmSync(this.plansScratch(wt.id), { recursive: true, force: true });
        throw e;
      }
      // the confirm promised the branch goes with the directory. Only toyon's own: an adopted
      // worktree's branch is the person's. Forced, since the archive ref holds its commits; best
      // effort, since the checkout is already gone and a leftover branch is the lesser surprise
      // than a remove that reports failure after doing most of its work.
      if (hasOwnBranch(wt)) {
        const r = await git(repo.path, "branch", "-D", wt.branch);
        if (!r.ok) log.warn(worktreeId, `could not delete branch ${wt.branch}: ${r.err}`);
      }
      return k;
    });
    const sessionId = this.d.state.session(worktreeId);
    const placed = repo.promptedAt;
    this.d.state.removeWorktree(worktreeId);
    this.tree.forget(worktreeId);
    // the project took the row's send: told before the rows frame drops the row, so the switcher
    // never shows the project sinking and climbing back
    if (repo.promptedAt !== placed) this.d.hub.emit("reposChanged");
    releasePort(wt.proxyPort);
    let archived: ArchivedWorktree | null = null;
    // the directory they were read against is gone, and a restore starts its own
    await dropTurnRefs(repo.path, worktreeId);
    if (archive) archived = this.archiveChat(wt, repo, kept, sessionId, reason);
    else {
      this.deleteChat(worktreeId);
      // nothing will list what it landed, so nothing needs those commits kept
      if (wt.lands?.length) await dropLandRefs(repo.path, worktreeId);
    }
    this.d.hub.emit("worktreesChanged");
    return archived;
  }

  /** The repo's teardown commands, in the directory while it is still there, with the same
   * variables setup had, so what setup made for this worktree alone (a database named for its
   * id) can be dropped. Outside the repo lock: a `dropdb` can take seconds and touches no
   * checkout. A failure is logged and the removal goes on, since a database left behind is the
   * lesser surprise than a directory that will not go. */
  private async teardown(wt: WorktreeInfo, repo: RepoInfo): Promise<void> {
    // a proc's own teardown first: what its setup made sat on what the repo's setup made, so it
    // unwinds in the reverse order. The branch's own file: what its setup made is what its file
    // knows how to drop.
    const { config } = configFor(wt, repo);
    const prepared = Object.entries(wt.sources ?? {})
      .filter(([, src]) => src.prepared)
      .map(([n]) => n);
    const cmds = [
      ...prepared.flatMap((n) => {
        const entry = config.run[n];
        return entry === undefined ? [] : procTeardown(entry);
      }),
      ...(config.teardown ?? []),
    ];
    // the record forgets what was prepared either way: a spare's refresh prepares again, and a
    // removed worktree's record is about to go
    for (const n of prepared) this.setSource(wt, n, { prepared: undefined });
    if (cmds.length === 0 || !existsSync(wt.path)) return;
    if (prepared.length > 0) this.d.state.save();
    for (const cmd of cmds) {
      const code = await runSetup(
        cmd,
        wt.path,
        (line) => this.d.hub.emit("log", wt.id, "setup", line),
        worktreeEnv(wt, repo),
        { timeoutMs: timeoutFor(config, "setup") },
      );
      if (code !== 0) log.warn(wt.id, `teardown failed (exit ${code}): ${cmd}`);
    }
  }

  /** a worktree's commits and uncommitted work, under its archive ref, before its directory goes */
  private async keep(repo: RepoInfo, wt: WorktreeInfo): Promise<KeptState | null> {
    const index = join(this.d.paths.archiveDir, `${wt.id}.index`);
    const kept = (await keepState(repo.path, wt.path, archiveRef(wt.id), index)) ?? (await this.keepUnlinked(repo, wt));
    if (!kept) log.warn(wt.id, "could not keep its git state");
    else if (kept.lost) log.warn(wt.id, "could not keep its uncommitted changes: only its commits are archived");
    return kept;
  }

  /** What is left to keep of a worktree git no longer lists. A remove that could not delete every
   * file still deleted git's record of the worktree, so the directory answers no git command and
   * nothing can be read from it again; the ref that remove wrote first holds its state, and a
   * worktree unlinked some other way still has its branch. Null while git lists the worktree,
   * since then something else went wrong. */
  private async keepUnlinked(repo: RepoInfo, wt: WorktreeInfo): Promise<KeptState | null> {
    if (await this.listed(repo, wt)) return null;
    const ref = archiveRef(wt.id);
    const already = await keptAt(repo.path, ref);
    if (already) return already;
    const head = await commitOf(repo.path, `refs/heads/${wt.branch}`);
    if (!head || !(await git(repo.path, "update-ref", ref, head)).ok) return null;
    return { head };
  }

  /** whether git still lists a worktree at its path; both sides canonical, since /tmp is a link */
  private async listed(repo: RepoInfo, wt: WorktreeInfo): Promise<boolean> {
    const path = canonical(wt.path);
    return (await listWorktrees(repo.path)).some((g) => canonical(g.path) === path);
  }

  /** The directory and git's record of it. Git deletes the record even when a file in the
   * directory refuses to go (one under a folder with no write bit, say) and reports the remove as
   * failed: what is left is a directory git no longer lists, which no later remove could take
   * either. So a remove that fails with the record gone finishes here, and a directory that still
   * will not go stays on disk, named in the log, rather than as a row that can never be archived. */
  private async removeDirectory(repo: RepoInfo, wt: WorktreeInfo): Promise<void> {
    const r = await git(repo.path, "worktree", "remove", "--force", wt.path);
    if (r.ok) return;
    if (await this.listed(repo, wt))
      throw new Error(`git worktree remove --force ${wt.path} failed (${r.exit}): ${r.err}`);
    if (await deleteTree(wt.path)) return;
    // the directory is toyon's own, so its write bits are toyon's to set
    await run("chmod", ["-R", "u+w", wt.path], dirname(wt.path));
    if (!(await deleteTree(wt.path))) log.warn(wt.id, `its directory could not be deleted and stays at ${wt.path}`);
  }

  /** where a worktree's plans wait between its directory going and its chat moving into the archive */
  private plansScratch(worktreeId: string): string {
    return join(this.d.paths.archiveDir, `${worktreeId}.plans`);
  }

  /** the plans a worktree was shown, copied out before its directory goes. Best effort: a chat
   * without its plans is still the chat, and the card keeps the proposed text either way. */
  private keepPlans(wt: WorktreeInfo): void {
    const from = join(wt.path, PLANS_DIR);
    if (!existsSync(from)) return;
    try {
      cpSync(from, this.plansScratch(wt.id), { recursive: true });
    } catch (e) {
      log.warn(wt.id, "could not keep its plans", e);
    }
  }

  /** The chat into the archive beside a record of the worktree. A failure leaves the files where
   * they were and says so, since deleting them is what the archive exists to stop. */
  private archiveChat(
    wt: WorktreeInfo,
    repo: RepoInfo,
    kept: KeptState | null,
    sessionId: string | undefined,
    reason?: string,
  ): ArchivedWorktree | null {
    const files = { ...this.chatFiles(wt.id), plans: this.plansScratch(wt.id) };
    const prompt = firstPrompt(files.transcript);
    // the spend goes on the record now, while the figure is one read away: the live map when the
    // stream reported this session, else the transcript about to move
    const cost = (this.usage.get(wt.id) ?? lastUsage(files.transcript))?.cost;
    const rec: ArchiveRecord = {
      worktree: wt,
      repoPath: repo.path,
      archivedAt: Date.now(),
      ...(sessionId ? { sessionId } : {}),
      ...(prompt ? { prompt } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(kept ? { kept } : {}),
      ...(reason ? { auto: reason } : {}),
    };
    let at: ChatFiles;
    try {
      at = this.archive.put(rec, files);
    } catch (e) {
      log.warn(wt.id, "could not archive its chat; the files stay where they were", e);
      return null;
    }
    this.d.hub.emit("archiveChanged", repo.id);
    return summarize(rec, repo.id, at.transcript);
  }

  /** the chat's own files; its plans sit in the worktree, so the caller names where they are */
  private chatFiles(worktreeId: string): Omit<ChatFiles, "plans"> {
    return {
      transcript: transcriptPathFor(this.d.paths.transcriptsDir, worktreeId),
      attachments: attachmentsDirFor(this.d.paths.attachmentsDir, worktreeId),
    };
  }

  /** a chat with nowhere to go: a spare's, a grafted source's, main's when its project is forgotten */
  deleteChat(worktreeId: string) {
    const files = this.chatFiles(worktreeId);
    try {
      rmSync(files.transcript, { force: true });
      rmSync(files.attachments, { recursive: true, force: true });
    } catch (e) {
      log.warn(worktreeId, "could not delete transcript or attachments", e);
    }
  }

  /** Drop the record of a worktree whose directory went while the daemon was down, or whose
   * project is no longer open, the way a remove would have: a task's chat is archived, with its
   * commits when its branch is still there, and any other chat is deleted. Nothing runs at boot, so
   * there is no runtime to stop. */
  async forgetGone(wt: WorktreeInfo): Promise<void> {
    const repo = this.d.state.repo(wt.repoId);
    const sessionId = this.d.state.session(wt.id);
    this.d.state.removeWorktree(wt.id);
    this.tree.forget(wt.id);
    if (!repo || wt.kind !== "worktree") {
      this.deleteChat(wt.id);
      return;
    }
    const kept = await withRepoLock(repo.path, async (): Promise<KeptState | null> => {
      await git(repo.path, "worktree", "prune");
      const head = await commitOf(repo.path, `refs/heads/${wt.branch}`);
      if (!head || !(await git(repo.path, "update-ref", archiveRef(wt.id), head)).ok) return null;
      if (hasOwnBranch(wt)) await git(repo.path, "branch", "-D", wt.branch);
      return { head };
    });
    this.archiveChat(wt, repo, kept, sessionId);
  }

  /** Rows archived before a project kept the send of what left it put theirs on it now, from the
   * records the archive holds, before the server opens; on every boot after, a project with an
   * archive has its stamp and one without has nothing to take. Without it a project tidied before
   * the upgrade would sit at the bottom of the switcher until its next send. */
  fillSentStamps(): void {
    let filled = 0;
    for (const repo of this.d.state.repos) {
      if (repo.promptedAt !== undefined) continue;
      let at = 0;
      for (const rec of this.archive.recordsOf(repo)) at = Math.max(at, sentAt(rec.worktree));
      if (at === 0) continue;
      repo.promptedAt = at;
      filled++;
    }
    if (filled === 0) return;
    this.d.state.save();
    log.info("daemon", `placed ${filled} projects by what their archives were sent`);
  }

  /** Marks written before a landing kept its subjects get them from the ref that kept each range:
   * one git log per such mark, a few at a time, over every project's rows and archive. Run once
   * at boot before the server opens, so no client ever reads a mark without them; on every boot
   * after, it finds nothing to do and reads no git. */
  async fillLandMarks(): Promise<void> {
    const jobs: FillJob[] = [];
    const rows = new Set<string>();
    const records = new Map<string, string>();
    for (const repo of this.d.state.repos) {
      for (const wt of this.d.state.worktrees) {
        if (wt.repoId !== repo.id) continue;
        for (const mark of wt.lands ?? []) {
          if (!unfilled(mark)) continue;
          jobs.push({ mark, cwd: repo.path });
          rows.add(repo.id);
        }
      }
      for (const rec of this.archive.recordsOf(repo)) {
        for (const mark of rec.worktree.lands ?? []) {
          if (!unfilled(mark)) continue;
          jobs.push({ mark, cwd: repo.path });
          records.set(rec.worktree.id, repo.id);
        }
      }
    }
    if (jobs.length === 0) return;
    await fillLandMarks(jobs, (cwd, m) => rangeSubjects(cwd, m.base, m.tip));
    if (rows.size) this.d.state.save();
    for (const id of records.keys()) this.archive.save(id);
    log.info("daemon", `read what ${jobs.length} earlier landings carried`);
  }

  /** whether the archive holds this id */
  hasArchived(archiveId: string): boolean {
    return !!this.archive.get(archiveId);
  }

  /** the title an archived worktree ended with, for naming one that is gone from the rail */
  archivedTitle(archiveId: string): string | undefined {
    return this.archive.get(archiveId)?.worktree.title;
  }

  /** a project's archived worktrees, newest first */
  archived(repoId: string): ArchivedWorktree[] {
    const repo = this.d.state.repo(repoId);
    return repo ? this.archive.list(repo) : [];
  }

  /** where each of a project's archived chats is kept, so a search reads them where they lie */
  archivedChats(repoId: string): Array<{ id: string; transcript: string }> {
    const repo = this.d.state.repo(repoId);
    if (!repo) return [];
    return this.archive.list(repo).flatMap((a) => {
      const files = this.archive.chatFiles(a.id);
      return files ? [{ id: a.id, transcript: files.transcript }] : [];
    });
  }

  /** an archived worktree's chat, read where it lies: its page shows the chat as it was, and only
   * a restore moves it. Null when no archive has the id. */
  archivedTranscript(archiveId: string): TranscriptEntry[] | null {
    const files = this.archive.chatFiles(archiveId);
    if (!files) return null;
    const { entries } = new Transcript(files.transcript, archiveId);
    // a turn the daemon died under is sealed here in memory, as a session seals its own on disk:
    // nothing writes an archive again
    const seal = sealOpenTurn(entries);
    return seal ? [...entries, { seq: (entries.at(-1)?.seq ?? -1) + 1, event: seal }] : entries;
  }

  /** an image in an archived chat, for the page that shows it; null unless the id names an archive
   * and the name is one the attachment store would have written */
  archivedAttachment(archiveId: string, file: string): string | null {
    const files = this.archive.chatFiles(archiveId);
    return files && isAttachmentFile(file) ? join(files.attachments, file) : null;
  }

  /** An archived worktree's git, read from the refs that kept it. Null unless the id names an
   * archive whose commits were kept, in a project that is open. */
  private archivedGit(archiveId: string): ArchivedGit | null {
    const rec = this.archive.get(archiveId);
    const repo = rec && this.repoOf(rec);
    if (!rec?.kept || !repo) return null;
    return new ArchivedGit(repo.path, rec.kept, rec.worktree.lands ?? [], baseOf(repo));
  }

  /** what an archived worktree left, for the changes panel on its page: nothing is on disk and
   * nothing moves, so it is one state, carried whole and never versioned */
  async archivedStatus(archiveId: string): Promise<GitInfo | null> {
    const kept = this.archivedGit(archiveId);
    if (!kept) return null;
    try {
      const { files, committed, head } = await kept.status();
      return { version: 0, files, head, extras: { committed } };
    } catch (e) {
      log.warn(archiveId, "reading its kept changes failed", e);
      return null;
    }
  }

  /** a file on an archived worktree's page: a commit's copy with `ref`, else what never landed
   * against where it forked. Null when no archive with kept commits has the id. */
  async archivedFile(archiveId: string, path: string, ref?: string): Promise<{ before: string; after: string } | null> {
    // a plan is a document the chat was shown, not a change: both sides are the file as it stands
    const plan = ref ? null : this.archive.planFile(archiveId, path);
    if (plan !== null) return { before: plan, after: plan };
    const kept = this.archivedGit(archiveId);
    return kept ? kept.file(path, ref) : null;
  }

  /** the project a record belongs to now: by id, or by checkout when it was forgotten and reopened */
  private repoOf(rec: ArchiveRecord): RepoInfo | undefined {
    return this.d.state.repo(rec.worktree.repoId) ?? this.d.state.repos.find((r) => r.path === rec.repoPath);
  }

  /** Put an archived worktree back as it was removed: its branch at the commit it was on, its
   * uncommitted work over that, unstaged, and its chat. The agent resumes its own session when the
   * directory is the same one, since that is what the session is keyed by. A `message` was typed
   * into the archived chat: it goes to the agent the way a new worktree's first one does. One
   * restore per id at a time, and an id that is a row already is that row: a second press, or a
   * message sent meanwhile, is asked of the worktree the first press brings back. */
  async restore(archiveId: string, createdBy?: string, message?: RestoreMessage): Promise<WorktreeInfo> {
    const running = this.restoring.get(archiveId);
    const live = running ? await running : this.d.state.worktree(archiveId);
    if (live) {
      if (message)
        await this.send(live.id, {
          text: message.text,
          clientId: createdBy,
          attachments: message.attachments,
          context: message.context,
        });
      return live;
    }
    const done = this.bringBack(archiveId, createdBy, message).finally(() => this.restoring.delete(archiveId));
    this.restoring.set(archiveId, done);
    return done;
  }

  /** The row and its chat first, the checkout behind them, the way a first send claims a spare
   * before its branch exists: the message reads as sent and the row sits on the rail from the
   * press, and the wait for the repo lock, seconds behind a landing, is read through on the live
   * page. The agent holds the message on its queue until the tree it runs in is there. A
   * checkout git refuses takes it all back: the row goes, the chat returns to the archive, and the
   * message goes back to the box it came from. */
  private async bringBack(archiveId: string, createdBy?: string, message?: RestoreMessage): Promise<WorktreeInfo> {
    const rec = this.archive.get(archiveId);
    if (!rec) throw new UserError("that archived worktree is gone");
    const old = rec.worktree;
    const repo = this.repoOf(rec);
    if (!repo) throw new UserError(`${old.title} belongs to a project that is not open`);
    const kept = rec.kept;
    if (!kept) throw new UserError(`${old.title} was archived without its commits, so there is nothing to restore`);
    // how often a worktree that archived itself is wanted back is what says whether the rule needs a
    // way to keep a row
    if (rec.auto) log.info(old.id, `restoring a worktree that archived itself (${rec.auto})`);
    // its old directory when that is free, else a fresh slot's: the record keeps its id either way,
    // since its chat, session and archive ref are keyed by it
    const path = existsSync(old.path) ? join(dirname(old.path), freeSlot(dirname(old.path)).dir) : old.path;
    const wt: WorktreeInfo = {
      ...old,
      repoId: repo.id,
      path,
      // the name it had; one taken since is found out under the lock, and the record follows
      branch: old.branch,
      proxyPort: await allocateProxyPort(),
      // bringing it back is going back to work in it, so it sits with what you last sent to
      promptedAt: Date.now(),
      // deps and setup come back, the procs wait: see startPreview
      parked: true,
      ...(createdBy ? { createdBy } : {}),
    };
    // teardown ran when it went: what its procs' setup had made is gone, and the setup below
    // makes it again. A hold on main's goes too: the files it was made over are not in view
    for (const n of Object.keys(wt.sources ?? {})) this.setSource(wt, n, { prepared: undefined, held: undefined });
    // the chat moves out of the archive now, since the live page reads it from where a running
    // worktree keeps it; the plans wait beside the archive until there is a tree to land in
    const chat: ChatFiles = { ...this.chatFiles(old.id), plans: this.plansScratch(old.id) };
    try {
      this.archive.take(old.id, chat);
    } catch (e) {
      // before anything is listed, so a refusal leaves the archive as it was
      log.warn(old.id, "could not move its chat back out of the archive", e);
      throw new UserError(`could not move ${old.title}'s chat back out of the archive`);
    }
    if (rec.sessionId && path === old.path) this.d.state.setSession(wt.id, rec.sessionId);
    this.arriving.add(wt.id);
    const { rt, release } = this.listAhead(wt, message);
    // on the row as a setup stage, like the cache restore and the deps copy that follow it: the
    // wait is the person's to read through, with the row saying what it is on
    const run = this.runs.begin(wt.id, "setup", {
      timeoutMs: timeoutFor(repo.config, "setup"),
      stage: "checking out the branch",
    });
    this.d.hub.emit("worktreesChanged");
    this.d.hub.emit("archiveChanged", repo.id);
    let branch: string;
    try {
      branch = await withRepoLock(repo.path, () => this.checkOutArchived(repo, old, kept, path));
    } catch (e) {
      await this.takeBack(wt, rec, chat, run, !!message);
      throw e;
    }
    run.finish(0);
    this.arriving.delete(wt.id);
    wt.branch = branch;
    move(chat.plans, join(path, PLANS_DIR));
    const dropped = await git(repo.path, "update-ref", "-d", archiveRef(old.id));
    if (!dropped.ok) log.warn(old.id, `could not drop its archive ref: ${dropped.err}`);
    this.tree.invalidate(wt.id);
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    fireAndForget(wt.id, this.setupAndStart(wt, repo, repo.path), "setup + start");
    // the word on the restore goes on the transcript ahead of the message, the way a land's does:
    // the chat picks up from where the archive cut it, and the row is what says how long the gap was
    rt.agent.note({
      type: "restored",
      archivedAt: rec.archivedAt,
      branch,
      uncommitted: !!kept.snapshot,
      ts: Date.now(),
    });
    // setup and procs warm in the background; the agent takes the message now, as on create
    release();
    // the tree is there to read: the changes panel on its page fills in
    this.d.hub.emit("filesChanged", wt.id);
    return wt;
  }

  /** The kept state checked out at `path`, under the lock: the branch it had, or a fresh name when
   * someone took that name since. Hands back the branch's name. A checkout git cannot finish is
   * taken down again here, since half a restore is a stray worktree git lists and toyon does not. */
  private async checkOutArchived(repo: RepoInfo, old: WorktreeInfo, kept: KeptState, path: string): Promise<string> {
    if (!(await commitOf(repo.path, archiveRef(old.id)))) {
      throw new UserError(`${old.title}'s kept commits are gone from git`);
    }
    let name = old.branch;
    let create = true;
    const tip = await commitOf(repo.path, `refs/heads/${name}`);
    if (tip && hasOwnBranch(old)) {
      // toyon deleted its own branch on archive, so a branch by that name now is someone else's
      name = `${name}-${shortId().slice(0, 3)}`;
    } else if (tip) {
      // the person's branch was never deleted and is checked out as it stands; uncommitted work
      // from an older commit would quietly undo whatever landed on it since
      if (tip !== kept.head && kept.snapshot) {
        throw new UserError(`${name} has moved since ${old.title} was archived: check it out in git instead`);
      }
      create = false;
    }
    try {
      await checkOutKept(repo.path, path, kept, { name, create });
    } catch (e) {
      await git(repo.path, "worktree", "remove", "--force", path);
      if (create) await git(repo.path, "branch", "-D", name);
      throw e;
    }
    return name;
  }

  /** A record on the list before git has had its say, its agent holding the first message: what a
   * restore and a take-over share, with `unlist` as the way back. Setup is marked from here so a
   * wake meanwhile (the preview asked for from the row) starts nothing in a tree that is not there
   * yet, or has no deps yet; setup's own mark takes over when it runs. The caller sends the frame. */
  private listAhead(wt: WorktreeInfo, message?: RestoreMessage): { rt: Runtime; release: () => void } {
    this.d.runtime.markSetup(wt.id, true);
    this.d.state.addWorktree(wt);
    const rt = this.d.runtime.ensureAgent(wt);
    const release = rt.agent.hold();
    if (message) rt.agent.send(message.text, { attachments: message.attachments, context: message.context });
    return { rt, release };
  }

  /** A restore git refused, after the row was listed: back to how it stood before the press, with
   * the chat returned to the archive. */
  private async takeBack(wt: WorktreeInfo, rec: ArchiveRecord, chat: ChatFiles, run: RunHandle, queued: boolean) {
    run.finish(0);
    await this.unlist(wt, queued);
    this.arriving.delete(wt.id);
    this.archive.put(rec, chat);
    this.d.hub.emit("worktreesChanged");
    this.d.hub.emit("archiveChanged", wt.repoId);
  }

  /** A row listed ahead of git, which git then refused: the record goes. The message leaves the
   * queue first, so the handler can put it back in its box. A refused press is not a send, so the
   * project's place in the switcher does not move with it. The caller sends the frame. */
  private async unlist(wt: WorktreeInfo, queued: boolean) {
    const agent = this.d.runtime.agentFor(wt.id);
    if (queued && agent && agent.queueLength > 0) agent.unqueue(0);
    await this.d.runtime.stop(wt.id);
    this.d.state.removeWorktree(wt.id, { refused: true });
    this.tree.forget(wt.id);
    releasePort(wt.proxyPort);
  }

  /** Delete an archived worktree for good: its record, chat and attachments, and the ref that kept
   * its commits alive. */
  async deleteArchived(archiveId: string): Promise<void> {
    const rec = this.archive.get(archiveId);
    if (!rec) return;
    const repo = this.repoOf(rec);
    const repoPath = repo?.path ?? rec.repoPath;
    if (rec.kept && existsSync(repoPath)) {
      const r = await git(repoPath, "update-ref", "-d", archiveRef(archiveId));
      if (!r.ok) log.warn(archiveId, `could not drop its archive ref: ${r.err}`);
    }
    if (rec.worktree.lands?.length && existsSync(repoPath)) await dropLandRefs(repoPath, archiveId);
    this.archive.delete(archiveId);
    this.d.drafts?.drop(archiveId);
    if (repo) this.d.hub.emit("archiveChanged", repo.id);
  }

  async rename(worktreeId: string, title: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    // the branch follows the title, and only a toyon/ branch is toyon's to move: an adopted
    // worktree's branch is the person's
    if (!canRename(wt)) throw new UserError(`${wt.title} keeps its own branch; rename it in git`);
    const repo = this.d.state.requireRepo(wt.repoId);
    const clean = cleanTitle(title);
    if (!clean) return;
    // The title is read and the branch is spelled: "Sticky header" on toyon/sticky-header. They are
    // set together so the two never drift, and a title git cannot spell (one written in another
    // script) is kept as the title with the branch left where it is. So is one whose branch git
    // would not move: the title is the row's name either way, and a row refused its name here
    // would keep the placeholder for the rest of the task.
    const slug = branchSlug(clean);
    let stayed: string | undefined;
    await withRepoLock(repo.path, async () => {
      let branch = `toyon/${slug}`;
      if (slug && branch !== wt.branch) {
        // avoid collisions with an existing branch
        let n = 2;
        let r = await git(wt.path, "branch", "-m", wt.branch, branch);
        while (!r.ok && n <= 5) {
          branch = `toyon/${slug}-${n++}`;
          r = await git(wt.path, "branch", "-m", wt.branch, branch);
        }
        if (r.ok) wt.branch = branch;
        else stayed = r.err.trim() || `git branch -m ${branch} failed`;
      }
      wt.title = clean;
      delete wt.unnamed;
    });
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    // after the name is on the row: the namer reads this as a warning, the person as a toast
    if (stayed) throw new UserError(`${clean} keeps the branch ${wt.branch}: ${stayed}`);
  }

  /** Merge other worktrees' branches into one and remove them. A local merge, nothing pushed: the
   * target keeps its title, procs, agent session and port, and the sources' transcripts are
   * appended to its own so the reasoning behind their commits stays readable. Every check runs
   * before anything is touched, and a conflict leaves both sides exactly as they were. No third
   * worktree holds the result: a `combined` kind would cost a directory, a deps clone, a port and a
   * cold agent with no memory of either side, for insurance the merge already provides. */
  async graft(targetId: string, sourceIds: string[]): Promise<{ target: WorktreeInfo; grafted: string[] }> {
    const target = this.d.state.worktree(targetId);
    if (!target) throw new UserError("that worktree is gone");
    const sources = [...new Set(sourceIds)]
      .filter((id) => id !== targetId)
      .map((id) => this.d.state.worktree(id))
      .filter((w): w is WorktreeInfo => !!w);
    if (sources.length === 0) throw new UserError("pick at least one worktree to graft on");
    const all = [target, ...sources];
    for (const w of all) {
      if (isMain(w)) throw new UserError("graft between worktrees, not onto or from main");
      if (!canGraft(w)) throw new UserError(`${w.title} cannot be grafted`);
      if (w.repoId !== target.repoId) throw new UserError("worktrees must belong to one repo");
      // a merge under an editing agent races its file tools, and a removal under one loses its
      // turn; refusing beats stopping someone's turn from a rail button
      if (isBusy(this.d.runtime.agentFor(w.id)?.status))
        throw new UserError(`${w.title}'s agent is mid-turn; stop it first`);
    }
    // uncommitted work is the one thing the merge would not carry and the removal would lose
    for (const w of all) {
      if ((await statusFiles(w.path)).length > 0)
        throw new UserError(`commit or discard the changes in ${w.title} first`);
    }
    const repo = this.d.state.requireRepo(target.repoId);
    await withRepoLock(repo.path, async () => {
      const m = await git(target.path, "merge", "--no-edit", ...sources.map((w) => w.branch));
      if (!m.ok) {
        await git(target.path, "merge", "--abort");
        throw new UserError(`branches conflict: these worktrees can't be grafted cleanly (${m.err.slice(0, 200)})`);
      }
    });
    // the sources' history rides along in order, each behind a marker saying where it came from.
    // Through the adapter, so the file, the in-memory copy and every open tab agree without a
    // reload; a cold source's session object reads its file and is closed again by remove().
    const agent = this.d.runtime.ensureAgent(target).agent;
    for (const w of sources) {
      const entries = this.d.runtime.ensureAgent(w).agent.transcript();
      agent.note({ type: "grafted", title: w.title, branch: w.branch, ts: Date.now() });
      for (const { event } of coalesce(entries)) agent.note(withoutAttachments(event));
    }
    for (const w of sources) await this.discardWorktree(w.id);
    await this.refreshLanded(target);
    await this.headMoved(target.id);
    return { target, grafted: sources.map((w) => w.title) };
  }

  /** A parked worktree's procs start: someone pressed for the preview, or its agent wrote a file.
   * While its setup is still running the wake does nothing and the start at the end of setup,
   * which now finds the record unparked, is what brings them up. */
  startPreview(worktreeId: string): void {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt?.parked) return;
    delete wt.parked;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    fireAndForget(worktreeId, this.d.runtime.wake(worktreeId), "start a parked preview");
  }

  /** The person asked for the preview back, on a row whose app is down: a parked row starts, a
   * proc that crashed, never answered or was stopped goes back under supervision, and a row asleep
   * or cold wakes (a wake that failed, say for want of a port, is tried again). The press is the
   * only path here: the agent writing a file starts a parked preview and nothing more, because a
   * crashed proc is restarted once its turn ends, not on every edit. */
  retryPreview(worktreeId: string): void {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    if (wt.parked) {
      this.startPreview(worktreeId);
      return;
    }
    const procs = this.d.runtime.get(worktreeId)?.procs;
    const down =
      procs && !procs.asleep
        ? procs.states().filter((p) => p.status === "crashed" || p.status === "unreachable" || p.status === "stopped")
        : [];
    if (down.length === 0) {
      fireAndForget(worktreeId, this.d.runtime.wake(worktreeId), "preview asked for");
      return;
    }
    for (const p of down) {
      fireAndForget(worktreeId, this.d.runtime.restartStream(worktreeId, p.name), "preview asked for");
    }
  }

  // ---- setup ----

  /** Clone deps from the base checkout, run the repo's setup commands, then start the runtime.
   *
   * `setupCommands: false` keeps the two copies (both no-ops when the destination already has the
   * files) and skips the settings' `setup` list, which has no such guard. Adoption uses it: those
   * commands are `bun install`, migrations, `docker compose up`, and a directory someone has been
   * working in is the last place to re-run them behind their back. */
  async setupAndStart(
    wt: WorktreeInfo,
    repo: RepoInfo,
    depsSource = repo.path,
    opts: { setupCommands?: boolean; start?: boolean } = {},
  ): Promise<void> {
    // marked for the runtime so a wake meanwhile (a tab landing on the row) does not start procs
    // on a tree whose deps are still being copied; the start at the end is this method's own
    this.d.runtime.markSetup(wt.id, true);
    try {
      await this.setupThenStart(wt, repo, depsSource, opts);
    } finally {
      this.d.runtime.markSetup(wt.id, false);
    }
  }

  /** A worktree gets the branch's files, so a .gitignore nobody has committed is not among them,
   * and then every ignored file in the tree reads as untracked work, the deps copy first of all.
   * The base checkout's rules go into the repo's info/exclude rather than the file being copied
   * in: git reads info/exclude from the common dir, so one write covers every worktree of the
   * repo, and it leaves the tree clean, which a carried file would not. An untracked .gitignore is
   * uncommitted work, and land and sync both refuse a worktree that has any.
   *
   * Keyed on the base checkout alone, never on the worktree being set up: info/exclude is one
   * file for every worktree of the repo, so a setup for a branch that carries a .gitignore of its
   * own must not clear the block an earlier worktree without one still reads. The block goes once
   * the base's .gitignore is tracked, when every branch cut from then on carries the rules itself,
   * and git reads a tree's own .gitignore ahead of info/exclude in any case. */
  private async mirrorBaseIgnore(repo: RepoInfo): Promise<void> {
    const src = join(repo.path, ".gitignore");
    const tracked = existsSync(src) && (await git(repo.path, "ls-files", "--", ".gitignore")).out !== "";
    const mirror = existsSync(src) && !tracked;
    const lines = mirror
      ? readFileSync(src, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
      : [];
    await excludeBlock(repo.path, BASE_IGNORE, lines);
  }

  private async setupThenStart(
    wt: WorktreeInfo,
    repo: RepoInfo,
    depsSource: string,
    { setupCommands = true, start = true }: { setupCommands?: boolean; start?: boolean },
  ): Promise<void> {
    await this.mirrorBaseIgnore(repo);
    // the tree's own file: an older branch installs and runs what its scripts answer to
    const cfg = configFor(wt, repo);
    for (const line of settingsLines(cfg, repo)) this.d.hub.emit("log", wt.id, "setup", line);
    const ceiling = timeoutFor(cfg.config, "setup");
    // what an earlier worktree built to pass the check comes first: keyed by this tree's own
    // lockfiles, it matches when main's copy would not, and a hit makes the copy below and the
    // install after it no-ops. It stands on the row as a setup stage of its own, since a clone of
    // a large tree is seconds a person waits through with nothing on the transcript yet.
    if (this.d.cache && cachePolicy(repo.config)) {
      const run = this.runs.begin(wt.id, "setup", { timeoutMs: ceiling, stage: "restoring cache" });
      await this.d.cache.restore(wt, repo, (line) => this.d.hub.emit("log", wt.id, "setup", line));
      run.finish(0);
    }
    // the base checkout's deps, copy-on-write where the fs allows it; the log line records which
    // path ran and how long the fallback copy takes per worktree
    const srcNm = join(depsSource, "node_modules");
    const dstNm = join(wt.path, "node_modules");
    if (existsSync(srcNm) && !existsSync(dstNm)) {
      // on the row as a stage like the cache restore: a copy of a large tree is seconds the
      // person reads the row through, and a row claimed meanwhile has no phase left to say so
      const run = this.runs.begin(wt.id, "setup", { timeoutMs: ceiling, stage: "copying dependencies" });
      const r = await cloneTree(srcNm, dstNm);
      run.finish(0);
      if (r.ok) this.d.hub.emit("log", wt.id, "setup", `deps via ${r.how} in ${r.ms}ms`);
      else log.warn(wt.id, "could not copy node_modules from the base checkout", r.error);
    }
    for (const f of LOCAL_CONFIG_FILES) {
      const src = join(depsSource, f);
      if (!existsSync(src) || existsSync(join(wt.path, f))) continue;
      const r = await run("cp", [src, join(wt.path, f)], wt.path);
      if (r.ok) this.d.hub.emit("log", wt.id, "setup", `copied ${f}`);
      else log.warn(wt.id, `could not copy ${f}`, r.err);
    }
    // `bun install` and friends can take a minute: async, so every preview and agent stream keeps
    // flowing while a new worktree warms up. Each command runs under the settings' setup ceiling
    // and stands on the row while it does, so the wait for it says how long and on what.
    const cmds = setupCommands ? (cfg.config.setup ?? []) : [];
    for (const [i, cmd] of cmds.entries()) {
      const stage = cmds.length > 1 ? `${cmd} (${i + 1} of ${cmds.length})` : cmd;
      const run = this.runs.begin(wt.id, "setup", { timeoutMs: ceiling, stage });
      const code = await runSetup(
        cmd,
        wt.path,
        (line, retract) => this.d.hub.emit("log", wt.id, "setup", line, retract),
        worktreeEnv(wt, repo),
        { timeoutMs: ceiling, onSpawn: run.spawned },
      );
      run.finish(code);
      if (code === "timeout") {
        this.d.hub.emit("log", wt.id, "setup", `setup gave up after ${describeDuration(ceiling)}: ${cmd}`);
      } else if (code !== 0) this.d.hub.emit("log", wt.id, "setup", `setup failed (exit ${code}): ${cmd}`);
    }
    // each proc the copy will run itself gets its own setup, the shared ones it borrows none: theirs
    // runs on the day the copy takes one over
    if (setupCommands) await this.prepareProcs(wt, repo, spawnsOf(resolveRun(cfg, wt, repo.tier ?? {})), "setup");
    // a cold worktree stops here: the first look at it, or the first request for its preview,
    // wakes it through the runtime, which starts a worktree whose setup is done and procs are not up
    if (start) await this.d.runtime.start(wt, repo);
  }

  // ---- landing ----

  /** what GitHub last said about the worktree's PR, or none once new work has moved past it */
  setPr(worktreeId: string, pr: PrState | undefined) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || (wt.pr === undefined && pr === undefined)) return;
    if (pr) wt.pr = pr;
    else delete wt.pr;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** The landed mark, by the one rule (landedNow), from facts in hand or read now. Every path
   * that lands and every status read come through here, so a merge by hand, by GitHub, by the
   * poll and by the press converge on the same mark, and a row marked landed before landings
   * were recorded clears on its next read. */
  private async refreshLanded(wt: WorktreeInfo, facts?: LandedFacts): Promise<void> {
    if (wt.kind === "main") return;
    const f = facts ?? (await this.landedFacts(wt));
    if (f) this.setLanded(wt, landedNow(wt, f));
  }

  /** The record after a landing, in one frame: the verdict goes and the landed mark comes
   * together. Sent one frame apart, the row between them carried work with no verdict, which the
   * box reads as a check to run, so its word flashed through "check" on the way to "archive". */
  private async settleLanded(wt: WorktreeInfo): Promise<string | undefined> {
    const repo = this.d.state.repo(wt.repoId);
    const f = wt.kind === "main" || !repo ? null : await this.landedFacts(wt);
    delete wt.landing;
    // the work is on the base by now, so a mark held back is news: the landed row says what held
    // it, and the log keeps it for a landing with no row (one git did by hand)
    let held: string | undefined;
    if (f && repo) {
      held = notLandedWhy(wt, f, baseOf(repo));
      if (held) {
        delete wt.landed;
        log.warn(wt.id, `landed, but not marked landed: ${held}`);
      } else wt.landed = true;
    }
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    return held;
  }

  private async landedFacts(wt: WorktreeInfo): Promise<LandedFacts | null> {
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return null;
    try {
      const [head, ab] = await Promise.all([git(wt.path, "rev-parse", "HEAD"), aheadBehind(wt.path, baseOf(repo))]);
      if (!head.ok) return null;
      return { head: head.out, ahead: ab.ahead };
    } catch (e) {
      log.warn(wt.id, "could not read the tree for the landed mark", e);
      return null;
    }
  }

  /** written only on change, and absent rather than false, so a row that never landed carries
   * nothing */
  private setLanded(wt: WorktreeInfo, landed: boolean) {
    if (!!wt.landed === landed) return;
    if (landed) wt.landed = true;
    else delete wt.landed;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the landing verdict for a worktree, or none: written after a turn, marked stale by a tree
   * that no longer matches it, and dropped by a new turn unless it says the work can land */
  private fingerprint(path: string): Promise<string> {
    return (this.d.fingerprint ?? treeFingerprint)(path);
  }

  setLanding(worktreeId: string, landing: Landing | undefined) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || (wt.landing === undefined && landing === undefined)) return;
    if (landing) wt.landing = landing;
    else delete wt.landing;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  private landable(worktreeId: string, verb: string): { wt: WorktreeInfo; repo: RepoInfo } {
    const pair = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (isMain(pair.wt)) throw new UserError(`${verb} from a worktree, not main`);
    if (!canLand(pair.wt)) throw new UserError(`${pair.wt.title} is a PR under review; it lands upstream, not here`);
    return pair;
  }

  /** the message a land or a ship commits with: what the person typed, else what the landing
   * verdict suggested. Neither means the press cannot commit, and the box to type one is named. */
  private commitMessage(wt: WorktreeInfo, typed?: string): string {
    const m = typed?.trim();
    if (m) return m;
    const s = wt.landing?.subject;
    if (s) return wt.landing?.body ? `${s}\n\n${wt.landing.body}` : s;
    throw new UserError("no commit message yet: write one in the changes panel");
  }

  /** commit everything when there is anything, with the message a land or a ship was given */
  private async commitIfDirty(wt: WorktreeInfo, typed?: string): Promise<ShipResult | null> {
    if ((await statusFiles(wt.path)).length === 0) return null;
    return this.commitRecorded(wt, this.commitMessage(wt, typed));
  }

  /** the one commit, for land and the changes panel alike. A refusal (a hook that rejected the
   * commit, and what it said) goes on the transcript whole through the watch: the line the person
   * reads has room for a sentence, and the agent only learns of what is on the transcript. */
  private async commitRecorded(wt: WorktreeInfo, message: string): Promise<ShipResult> {
    const result = await commitWorktree(wt.path, message, this.landWatch(wt));
    if (result.ok) {
      await this.verdictSurvives(wt, { dropMessage: true });
      await this.headMoved(wt.id);
    }
    return result;
  }

  /** The watch a landing's steps run under: each step's name goes to the row's subscribers, so
   * the press says what it is on instead of spinning, and each git command runs through
   * ExecService.watch, so a hook's minutes read live on the chat and its refusal is whole for the
   * message that asks the agent to fix it. A command in the main checkout is named with its `-C`, since the row
   * sits on a worktree's chat. A worktree with no transcript yet runs the steps plain.
   *
   * A commit is the step with a suite in it (pre-commit), so it runs under the settings' commit
   * ceiling rather than the step's, and stands on the row as a run while it does: which hook git
   * is in, from git's own trace, and the last line the hook printed. */
  private landWatch(wt: WorktreeInfo): LandWatch {
    const repo = this.d.state.requireRepo(wt.repoId);
    return {
      step: (name) => this.step(wt.id, name),
      git: async (cwd, args) => {
        const where = cwd === wt.path ? "git" : `git -C ${cwd}`;
        const commit = args[0] === "commit";
        const ceiling = commit ? timeoutFor(repo.config, "commit") : STEP_TIMEOUT_MS;
        const handle = commit ? this.runs.begin(wt.id, "commit", { timeoutMs: ceiling }) : null;
        const run = (onText: (text: string) => void, signal?: AbortSignal) =>
          stepRun(cwd, args, onText, signal, {
            timeoutMs: ceiling,
            ...(handle ? { onSpawn: handle.spawned } : {}),
            // every step's hooks are watched, a push's as much as a commit's: the one that exits
            // non-zero is what refused the step, and only git's trace says which
            onHook: (hook) => handle?.stage(hook ? `${hook} hook` : undefined),
          });
        const watched = async () => {
          if (!this.d.watch) return run(() => {});
          const command = `${where} ${commandLine(args)}`;
          try {
            return { ...(await this.d.watch(wt.id, command, run)), command };
          } catch (e) {
            // no transcript to write to (the agent is not up yet): the step runs plain, and the line
            // under the box carries git's first words
            log.warn(wt.id, `landing step runs unwatched: ${e instanceof Error ? e.message : e}`);
            return run(() => {});
          }
        };
        const r = await watched();
        handle?.finish(r.exit);
        return r;
      },
    };
  }

  /** A commit by hand or a sync moves HEAD, and the next status read would mark the verdict stale
   * for it; but the check and the sentence were about these same bytes, so the verdict follows
   * with its fingerprint refreshed. After a commit the message goes: it is in git now, and the box
   * would otherwise keep offering what was just committed. After a sync it stays. */
  private async verdictSurvives(wt: WorktreeInfo, opts: { dropMessage: boolean }) {
    const l = wt.landing;
    if (!l || l.check === "pending") return;
    const { subject, body, unanswered, ...kept } = l;
    // the mark that a message was owed goes with the message: the commit by hand supplied one
    const message = opts.dropMessage
      ? {}
      : { ...(subject ? { subject } : {}), ...(body ? { body } : {}), ...(unanswered ? { unanswered } : {}) };
    this.setLanding(wt.id, { ...kept, ...message, fingerprint: await this.fingerprint(wt.path) });
  }

  /** The row lands the way the press lands it, for a landing git did without toyon (handLanding):
   * the range kept under a ref, the branch restarted from main so the next hand landing counts only
   * the commits after this one, and the verdict gone with the work it described. */
  private async landedByHand(wt: WorktreeInfo, mark: LandingRange) {
    const repo = this.d.state.requireRepo(wt.repoId);
    log.info(wt.id, `landed on ${baseOf(repo)} outside toyon: ${mark.base.slice(0, 7)}..${mark.tip.slice(0, 7)}`);
    await this.noteLand(repo, wt, mark);
    await this.restartFromMain(wt, baseOf(repo));
    await this.settleLanded(wt);
    // a hand landing writes no `landed` row, since nothing of Toyon's ran, but it is a landing the
    // siblings and the origin wait on all the same
    this.d.hub.emit("landed", wt.id);
  }

  /** The one press. Commit what is uncommitted, take main in (a rebase for toyon's own branch),
   * then the repo's route: merge here, merge here and push main, or push the branch and open a
   * PR. On a worktree whose PR is already open: push the work the PR is missing when there is
   * any, else merge the PR. Each step stops the rest when it fails, and the result says which: a
   * commit stands even when the rebase after it conflicts, since the work is safer committed. The
   * worktree stays, marked landed once the work is on main here, so the conversation can go on;
   * closing it is its own press. */
  async land(worktreeId: string, message?: string): Promise<{ result: ShipOutcome }> {
    const { wt, repo } = this.landable(worktreeId, "land");
    // inside the op, so the press is the one out on the row from its first tick
    const out = await this.ship(wt.id, "land", "press", async (): Promise<Landed> => {
      await this.followBranch(wt);
      const moved = await this.movedMidTurn(wt);
      if (moved) return { result: moved };
      return this.landOp(wt, repo, message);
    });
    if (out.result.ok && out.landed) this.noteLanded(wt, out.result.message, out);
    return { result: this.fixShip(wt, out.result, baseOf(repo)) };
  }

  /** What a landing op's failure asks of the agent, after the op, whose hold on the queue is gone
   * by now. A hook that refused a commit or a push printed why on the transcript, and a rebase or
   * merge that stopped on conflicts names what to merge: both are the agent's to fix. A
   * commit-msg hook judged the message and not the tree, so the message is written again with
   * what the hook said, and the line says so. The op is not run again when the fix is in: the fix
   * changes what the press was about, and the check after the turn offers the word on the new
   * tree. */
  private fixShip(wt: WorktreeInfo, result: ShipResult, base: string): ShipOutcome {
    if (result.ok) return result;
    if (result.hook?.name === "commit-msg") {
      this.d.hub.emit("messageRefused", wt.id, result.hook.text.trim().slice(-REFUSAL_CHARS));
      return { ...result, message: "the commit-msg hook refused the message: another is being written" };
    }
    const { hook } = result;
    const failure: Failure | null = hook
      ? { kind: "hook", hook: hook.name, toolId: hook.toolId, command: hook.command, text: hook.text }
      : result.conflict
        ? {
            kind: "conflict",
            base,
            how: result.conflict,
            ...(result.step ? { step: result.step } : {}),
            ...(result.carried ? { carried: result.carried } : {}),
          }
        : null;
    return failure && this.d.fix.report(wt.id, failure) ? { ...result, asked: true } : result;
  }

  /** The boot pane's "ask the agent to fix it", for a dev server that crashed or never answered:
   * the diagnosis, the command and the output tail, as the daemon holds them. The lead has no
   * task yet, so its fix is the worktree its box would start, with the diagnosis as its task: the
   * provisional row itself, or a worktree of main's own, whose procs start from the same broken
   * command. */
  async fixPreview(worktreeId: string, clientId?: string): Promise<void> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const failure: Failure = {
      kind: "preview",
      procs: this.d.runtime.get(worktreeId)?.procs?.states() ?? [],
      log: this.d.runtime.recentLogs(worktreeId),
    };
    if (!isLead(wt)) {
      if (!this.d.fix.report(worktreeId, failure, { pressed: true }))
        throw new UserError("worktree still starting; try again in a moment");
      return;
    }
    await this.create(wt.repoId, fixPrompt(failure), {
      ...(clientId ? { createdBy: clientId } : {}),
      ...(isProvisional(wt) ? { worktreeId } : {}),
    });
  }

  /** A land pressed mid-turn was offered on the verdict's tree, and the agent can write a file
   * between the frame that offered the word and the press: the commit would take bytes no check
   * saw. Refused here, where the tree is read under the op. At rest the tree moves only by the
   * person's own hand, and what they land is theirs to say. */
  private async movedMidTurn(wt: WorktreeInfo): Promise<ShipResult | null> {
    if (!isBusy(this.d.runtime.agentFor(wt.id)?.status)) return null;
    const l = wt.landing;
    if (!l || l.fingerprint === (await this.fingerprint(wt.path))) return null;
    return { ok: false, message: "the agent has changed files since the check: land once its turn ends" };
  }

  /** the word on a land that put the work on main, on the transcript the way a graft's marker is:
   * the row reads it back after a reload, where a frame to the sockets open at the time would not.
   * The siblings ride along for the row to offer, for as long as they are still rows. */
  private noteLanded(wt: WorktreeInfo, message: string, o: Pick<Landed, "mark" | "url" | "held">) {
    this.d.runtime.ensureAgent(wt).agent.note({
      type: "landed",
      message,
      ...(o.mark ? { mark: o.mark } : {}),
      ...(o.url ? { url: o.url } : {}),
      ...(o.held ? { held: o.held } : {}),
      ts: Date.now(),
    });
    // after the row's own word: a worktree that handed this work off hears of it from here
    this.d.hub.emit("landed", wt.id);
  }

  /** The record's branch is whatever the checkout is on. A hand switches branches in a worktree
   * the way it edits files there, and every count is read from HEAD already; a land that merged
   * the record's branch while HEAD was on another would report a landing of nothing and then
   * reset the branch with the work. A detached HEAD leaves the record as it was: there is no
   * branch to follow, and the land refuses on its own. Read here on every status and before a
   * landing, since a switch moves no file the watcher sees. */
  private async followBranch(wt: WorktreeInfo, current?: string): Promise<void> {
    if (wt.kind === "main") return;
    const branch = current ?? (await git(wt.path, "branch", "--show-current")).out;
    if (!branch || branch === wt.branch) return;
    log.info(wt.id, `on ${branch} now, not ${wt.branch}: the row follows the checkout`);
    wt.branch = branch;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the landing op out on a row or a trunk, for its frame and for what is refused meanwhile */
  shippingOf(id: string): Shipping | undefined {
    return this.ops.get(id);
  }

  /** Run a landing op as the one out on the row: on every frame while it runs, with the agent's
   * queue held so a chat sent meanwhile waits rather than run under a rebase, and a second press
   * refused. The refusal is by id, so a found row and a trunk count too; a row with no agent (a
   * found worktree, main) has nothing to hold. A press is a hand on the row, so the row goes to
   * the top of the rail like a send's, at the press and whatever comes of it: a commit hook can
   * hold the op for minutes, and the row should not wait for it. Landed, it reads as the next
   * thing to archive; refused, it is the row whose failure is being fixed. An op nobody pressed
   * (a sync that waited for the turn, the trunk's pull) moves nothing. */
  private async ship<T>(id: string, op: ShipOp, by: "press" | "auto", run: () => Promise<T>): Promise<T> {
    const out = this.ops.get(id);
    if (out) throw new UserError(`${shipNoun(out.op)} is already running here`);
    // held before the frame says so: a send that reads the frame must find the queue held
    const release = this.d.runtime.agentFor(id)?.hold();
    this.ops.set(id, { op });
    // on the op's first frame, with the word it shows
    if (by === "press") this.stampPrompted(id);
    this.d.hub.emit("worktreesChanged");
    // an op out longer than a git call may run is waiting on the repo lock, the fetch lock or a
    // turn, and the row shows only the shining word: the log names the wait every ceiling
    const started = Date.now();
    const watchdog = setInterval(() => {
      const step = this.ops.get(id)?.step;
      const at = step ? ` at "${step}"` : "";
      log.warn(id, `${shipNoun(op)} still running after ${describeDuration(Date.now() - started)}${at}`);
    }, RUN_CEILING_MS);
    watchdog.unref?.();
    try {
      return await run();
    } finally {
      clearInterval(watchdog);
      this.ops.delete(id);
      release?.();
      this.d.hub.emit("worktreesChanged");
      // a sync that waited for the turn and then for this op runs now, while the tree is still
      if (!isBusy(this.d.runtime.agentFor(id)?.status)) this.syncAfterTurn(id);
    }
  }

  /** the op moved on: its frame says so, for whoever is waiting on it */
  private step(id: string, name: string) {
    const out = this.ops.get(id);
    if (!out || out.step === name) return;
    out.step = name;
    this.d.hub.emit("worktreesChanged");
  }

  private async landOp(wt: WorktreeInfo, repo: RepoInfo, message?: string): Promise<Landed> {
    const policy = landPolicy(repo.config);
    const own = hasOwnBranch(wt);
    const w = this.landWatch(wt);
    // what the newest commit's work is called: the message typed for it, else the verdict's.
    // Where the whole branch is named at once (a squash, a PR), squashMessage puts the branch's
    // earlier subjects under it.
    const typed = message?.trim();
    const suggested =
      typed ||
      (wt.landing?.subject
        ? wt.landing.body
          ? `${wt.landing.subject}\n\n${wt.landing.body}`
          : wt.landing.subject
        : undefined);

    const base = baseOf(repo);
    if (policy.land === "pr") {
      // GitHub merged the PR while an op was out on the row, so the poll left the landing to this
      // press: it lands the merge, never a second PR of the same commit
      if (wt.pr?.state === "merged" && !prTaken(wt)) {
        const { mark, held, ...result } = await this.prMergedOp(wt.id, undefined, w);
        return result.ok ? { result, landed: true, mark, held, url: wt.pr.url } : { result };
      }
      // the branch is measured against origin's main, fetched now: main here is not pulled on
      // this route and can trail origin by days
      const fetched = await this.fetchBase(wt, repo, w);
      if (!fetched.ok) return { result: fetched };
      // nothing here touches the main checkout, and gh holds the network for seconds: outside the lock
      if (wt.pr?.state === "open") {
        // work since the PR opened goes to the PR, never under it: a merge now would take the
        // PR as GitHub has it and strand what is here
        const dirty = (await statusFiles(wt.path)).length > 0;
        const missing = dirty || ((await aheadUpstream(wt.path, wt.branch)) ?? 0) > 0;
        if (!missing) {
          const result = await mergePr(wt.path, wt.pr.number, policy.merge, w);
          // queued rather than merged: the row says so now, not on the poll's next pass
          if (result.ok && result.queued)
            this.setPr(wt.id, { ...wt.pr, queue: true, queued: "waiting", at: Date.now() });
          return { result };
        }
        const committed = await this.commitIfDirty(wt, message);
        if (committed && !committed.ok) return { result: committed };
        // marked before each move: a read out across it answers for the tree before, and is dropped
        this.tree.invalidate(wt.id);
        const taken = await takeMainIn(wt.path, base, own, w);
        if (!taken.ok) return { result: taken };
        await this.headMoved(wt.id);
        this.tree.invalidate(wt.id);
        const pushed = await pushBranch(wt.path, wt.branch, w);
        if (!pushed.ok) return { result: pushed };
        await this.headMoved(wt.id);
        this.setLanding(wt.id, undefined);
        const did = committed ? "committed and pushed" : "pushed";
        // GitHub drops a PR from the merge queue when its head moves: the row says so now rather
        // than "in the merge queue" until the poll, and the land word comes back with it
        if (wt.pr.queued) {
          const { queued: _, ...left } = wt.pr;
          this.setPr(wt.id, { ...left, at: Date.now() });
          return {
            result: {
              ok: true,
              url: wt.pr.url,
              message: `${did}; PR #${wt.pr.number} has the new commits and left the merge queue: land it again once it is ready`,
            },
          };
        }
        return { result: { ok: true, url: wt.pr.url, message: `${did}; PR #${wt.pr.number} has the new commits` } };
      }
      const committed = await this.commitIfDirty(wt, message);
      if (committed && !committed.ok) return { result: committed };
      // read before the rebase: what the branch carried, in case the rebase finds it all on origin
      const mark = await landingMark(wt.path, base);
      this.tree.invalidate(wt.id);
      const taken = await takeMainIn(wt.path, base, own, w);
      if (!taken.ok) return { result: taken };
      await this.headMoved(wt.id);
      // the rebase dropped every commit: origin's main holds this work already, through a PR
      // merged where toyon did not see it. The row lands the way a merged PR lands it.
      if ((await aheadBehind(wt.path, base)).ahead === 0) {
        const { mark: noted, held, ...r } = await this.prMergedOp(wt.id, mark, w);
        const on = `origin's ${repo.defaultBranch} has this work already`;
        const result = { ...r, message: r.ok ? `${on}; ${r.message}` : `${on}, but ${r.message}` };
        return r.ok ? { result, landed: true, mark: noted, held, url: wt.pr?.url } : { result };
      }
      // the branch's earlier subjects go under the title only where GitHub will squash them away;
      // a PR merged by rebase or merge keeps its commits, and the message is the newest work's
      const named = !suggested
        ? undefined
        : splitMessage(policy.merge === "squash" ? await squashMessage(wt.path, base, suggested, !!typed) : suggested);
      const result = await openPr(
        {
          worktreePath: wt.path,
          branch: wt.branch,
          defaultBr: repo.defaultBranch,
          base,
          subject: named?.subject,
          body: named?.body,
          automerge: policy.automerge,
          method: policy.merge,
        },
        w,
      );
      if (result.ok) {
        this.setLanding(wt.id, undefined);
        if (result.pr) this.setPr(wt.id, { ...result.pr, at: Date.now() });
      }
      return { result };
    }

    if (policy.land === "push") return this.landPush(wt, repo, policy, message, suggested, w);

    let mergedHere = false;
    let committedHere = false;
    let held: string | undefined;
    let noted: LandMark | undefined;
    const result = await withRepoLock(repo.path, async (): Promise<ShipResult> => {
      const committed = await this.commitIfDirty(wt, message);
      if (committed && !committed.ok) return committed;
      committedHere = committed !== null;
      const method = policy.merge ?? DEFAULT_MERGE_METHOD;
      const merged = own && method === "rebase" ? await requireLinear(wt.path, base) : null;
      if (merged) return merged;
      const taken = await takeMainIn(wt.path, base, own, w);
      if (!taken.ok) return taken;
      // read before the landing moves main and the branch restarts from it
      const mark = await landingMark(wt.path, base);
      const squash = method === "squash" ? await squashMessage(wt.path, base, suggested, !!message?.trim()) : "";
      const landed = await landLocally(wt.path, wt.branch, repo.path, repo.defaultBranch, method, squash, w);
      if (!landed.ok) return landed;
      mergedHere = true;
      noted = await this.noteLand(repo, wt, mark, { squash });
      await this.restartFromMain(wt, base);
      return landed;
    });
    if (mergedHere) {
      // main moved, so every row of this repo counts against it now. The ref watcher clears this
      // too, but on the fs event's schedule, and the frame the landed mark pushes must not carry
      // the old ahead. The verdict was about work that is on main now; the landed mark is what
      // the box reads next.
      this.invalidateCounts();
      held = await this.settleLanded(wt);
    }
    if (!result.ok) return { result };
    // the row says what the press did, not where the work sits: "is on main" read as the press
    // having found it there and done nothing
    const did = committedHere ? "committed and merged" : "merged";
    return {
      result: { ...result, message: `${did} into ${repo.defaultBranch}` },
      landed: true,
      mark: noted,
      held,
    };
  }

  /** The push route: the landing built in the worktree and pushed straight to main on origin, so
   * nothing about the main checkout can block it. The branch takes the base in, fetched now; the
   * repo's method makes the landing commit here (landingCommit), so the repo's hooks run on what
   * reaches main, in the worktree and with its environment; and that commit goes to origin's
   * main. Origin moving in between is met once, fetch, rebase, rebuild, push again; a second
   * rejection asks for another press. Nothing here holds the repo lock but the record and the
   * restart: the worktree and the network are all the route touches, as on the PR route. Main
   * here follows as the trunk's housekeeping, and its note says why when it cannot. */
  private async landPush(
    wt: WorktreeInfo,
    repo: RepoInfo,
    policy: LandPolicy,
    message: string | undefined,
    suggested: string | undefined,
    w: LandWatch,
  ): Promise<Landed> {
    const base = baseOf(repo);
    const own = hasOwnBranch(wt);
    const method = policy.merge ?? DEFAULT_MERGE_METHOD;
    const committed = await this.commitIfDirty(wt, message);
    if (committed && !committed.ok) return { result: committed };
    // read before the fetch, the rebase and the method rewrite the branch: the commits it carried,
    // kept under the landing's ref. One read stands for a second attempt, whose branch is by then
    // the first attempt's landing commit.
    const read = await landingMark(wt.path, base);
    if (!read) return { result: { ok: false, message: `nothing to land: no commits ahead of ${base}` } };
    let sha = "";
    // the rebase dropped every commit: origin's main holds this work already, pushed by a hand
    // toyon did not see. Nothing to build or push; the row lands on the record as it stands.
    let already = false;
    // the squash message main received, when the method is squash: what the mark says landed
    let squash = "";
    const merged = own && method === "rebase" ? await requireLinear(wt.path, base) : null;
    if (merged) return { result: merged };
    for (let attempt = 0; ; attempt++) {
      const fetched = await this.fetchBase(wt, repo, w);
      if (!fetched.ok) return { result: fetched };
      // marked before each move: a read out across it answers for the tree before, and is dropped
      this.tree.invalidate(wt.id);
      const taken = await takeMainIn(wt.path, base, own, w);
      if (!taken.ok) return { result: taken };
      await this.headMoved(wt.id);
      if ((await aheadBehind(wt.path, base)).ahead === 0) {
        already = true;
        sha = (await commitOf(wt.path, base)) ?? "";
        break;
      }
      squash = method === "squash" ? await squashMessage(wt.path, base, suggested, !!message?.trim()) : "";
      this.tree.invalidate(wt.id);
      const built = await landingCommit(wt.path, wt.branch, base, method, squash, own, w);
      await this.headMoved(wt.id);
      if (!built.ok || !built.sha) return { result: built };
      sha = built.sha;
      const pushed = await pushLanding(wt.path, sha, repo.defaultBranch, w);
      if (pushed.ok) break;
      if (!pushed.moved) return { result: pushed };
      if (attempt > 0) {
        return { result: { ok: false, message: `${base} moved twice while this landed; land again` } };
      }
    }
    // origin's main is the pushed commit now, and the remote-tracking ref should say so from the
    // push itself; a fetch refspec that covers less than the branch is caught by reading it back
    if ((await commitOf(wt.path, base)) !== sha) await this.fetchBase(wt, repo, w);
    let noted: LandMark | undefined;
    await withRepoLock(repo.path, async () => {
      noted = await this.noteLand(repo, wt, read, { squash });
      await this.restartFromMain(wt, base);
    });
    this.invalidateCounts();
    const held = await this.settleLanded(wt);
    const followed = await this.trunk.catchUp(repo.id);
    const here = followed.ok
      ? `${repo.defaultBranch} here ${followed.moved ? "pulled it" : "has it"}`
      : `${repo.defaultBranch} here was left where it is: ${followed.message}`;
    const how = { merge: "merged into", squash: "squashed onto", rebase: "rebased onto" }[method];
    const did = already
      ? `origin's ${repo.defaultBranch} has this work already`
      : `${committed ? `committed and ${how}` : how} ${repo.defaultBranch} and pushed`;
    return { result: { ok: true, message: `${did}; ${here}` }, landed: true, mark: noted, held };
  }

  /** A landing onto the record, oldest first, with its tip kept under a ref: the branch restarts from
   * main after it, and a squash never puts these commits on main, yet an archived worktree's page
   * still lists them. The mark says what landed in one line each: a merged PR's title, since
   * GitHub lands the PR by its own method and under that name; the squash message's subject for
   * a squash (the range names the originals, which main never got); the range's own subjects
   * otherwise. Returns the mark it wrote, so the row's word carries it; nothing when the ref
   * could not be kept. */
  private async noteLand(
    repo: RepoInfo,
    wt: WorktreeInfo,
    mark: LandingRange | null,
    opts: { pr?: PrState | undefined; squash?: string | undefined } = {},
  ): Promise<LandMark | undefined> {
    if (!mark) return undefined;
    const n = wt.lands?.length ?? 0;
    const pinned = await git(repo.path, "update-ref", landRef(wt.id, n), mark.tip);
    if (!pinned.ok) {
      log.warn(wt.id, `could not keep the commits it landed: ${pinned.err}`);
      return undefined;
    }
    const noted: LandMark = {
      ...mark,
      at: Date.now(),
      ...(opts.pr ? { pr: opts.pr.number } : {}),
      subjects: await this.landedWhat(repo, wt, mark, opts),
    };
    wt.lands = [...(wt.lands ?? []), noted];
    this.d.state.save();
    return noted;
  }

  private async landedWhat(
    repo: RepoInfo,
    wt: WorktreeInfo,
    mark: LandingRange,
    opts: { pr?: PrState | undefined; squash?: string | undefined },
  ): Promise<string[]> {
    if (opts.pr?.title) return [opts.pr.title];
    const subject = opts.squash ? splitMessage(opts.squash).subject : "";
    if (subject) return [subject];
    const read = await rangeSubjects(repo.path, mark.base, mark.tip);
    // the ref was pinned in this repo a moment ago, so a read that fails is news worth a line
    if (!read) log.warn(wt.id, `could not read what it landed: ${mark.base.slice(0, 7)}..${mark.tip.slice(0, 7)}`);
    return read ?? [];
  }

  /** the tip alone, as a landing with nothing under it: what goes on the record when a merged PR
   * left no range to read (the base already had every commit, and the reflog names none) */
  private async tipMark(wt: WorktreeInfo): Promise<LandingRange | null> {
    const head = await git(wt.path, "rev-parse", "HEAD");
    return head.ok ? { base: head.out, tip: head.out } : null;
  }

  /** A branch toyon owns restarts from the base once its work is there: the next message here
   * builds on the base as it is, and the counts read zero rather than the commits a squash or a
   * rebase on GitHub left with different hashes. An adopted branch keeps its history. `--keep`,
   * since a PR merges while a person may be mid-edit here: an edit the reset would not touch
   * rides over onto the base, and one it would overwrite refuses the reset whole, leaving the
   * branch on its landed tip, which the row reads as landed all the same; the counts carry the
   * edit as work left over. */
  private async restartFromMain(wt: WorktreeInfo, base: string): Promise<void> {
    if (!hasOwnBranch(wt)) return;
    // marked before the move: a read out across it answers for the tree before, and is dropped
    this.tree.invalidate(wt.id);
    const r = await git(wt.path, "reset", "--keep", base);
    if (!r.ok) log.warn(wt.id, `could not restart ${wt.branch} from ${base}: ${r.err}`);
    // the counts for the moved head, said in the settle's frame with the landed mark: a frame of
    // its own here carried the landing on the record without the mark, which a row reads as new
    // work over a landed PR
    await this.tree.refresh(wt.id);
  }

  /** the base fetched before a land or a sync measures against it (fetchBase), with the fetch on
   * the trunk's record either way, since every count against origin is as true as it */
  private async fetchBase(wt: WorktreeInfo, repo: RepoInfo, w: LandWatch): Promise<ShipResult> {
    if (!baseIsRemote(repo)) return { ok: true, message: `${baseOf(repo)} here is the base` };
    const r = await withFetchLock(repo.path, () => fetchBase(wt.path, repo, w));
    this.trunk.noteFetch(repo.id, { ok: r.ok, err: r.message });
    return r;
  }

  /** GitHub merged the worktree's PR: that is the landing, wherever it was merged from. The record
   * takes it and the branch restarts from main whatever state main here is in; main follows
   * origin as the trunk's own housekeeping, and when it cannot (edits in its way, a fetch refused)
   * the trunk's note says why and main's own pull is the retry. The row never waits on main: the
   * work is on origin, which is what the PR route measures against. `carried` is the range the
   * branch held before a rebase onto origin dropped it, when the press found the work on origin
   * already; read here otherwise. The poll runs unwatched; a press names its steps.
   *
   * `prMerged` is the poll's own entry: with nobody pressing, its landing is still shown on the
   * row the way a press is, and it is left to the press when one is out, since that press lands
   * the merged PR itself. */
  async prMerged(worktreeId: string): Promise<ShipResult> {
    const wt = this.d.state.worktree(worktreeId);
    const pr = wt?.pr ? `PR #${wt.pr.number}` : "the PR";
    const out = this.ops.get(worktreeId);
    // said each time the poll comes round: nobody pressed this, so the log is the one place a
    // landing that waits on an op that never ends can be seen
    if (out) {
      const message = `${shipNoun(out.op)} is already running here`;
      log.info(worktreeId, `${pr} merged on GitHub; ${message}, landing waits`);
      return { ok: false, message };
    }
    // landed once: a second poll, or one that raced the first, records nothing more
    if (wt && prTaken(wt)) return { ok: true, message: `${pr} merged; landed already` };
    log.info(worktreeId, `${pr} merged on GitHub; landing it`);
    const { mark, held, ...result } = await this.ship(worktreeId, "land", "auto", () => this.prMergedOp(worktreeId));
    if (result.ok) log.info(worktreeId, `landed: ${result.message}`);
    else log.warn(worktreeId, `landing failed: ${result.message}`);
    if (result.ok && wt) this.noteLanded(wt, result.message, { mark, url: wt.pr?.url, held });
    return result;
  }

  private async prMergedOp(
    worktreeId: string,
    carried?: LandingRange | null,
    w: LandWatch = UNWATCHED,
  ): Promise<ShipResult & { mark?: LandMark | undefined; held?: string | undefined }> {
    const { wt, repo } = this.d.state.requireWorktreeWithRepo(worktreeId);
    const br = repo.defaultBranch;
    const base = baseOf(repo);
    // read before the base moves: a merge that kept the commits' hashes puts them on it, and
    // the range would then read as nothing to keep
    const read = carried === undefined ? await landingMark(wt.path, base) : carried;
    const pulled = await this.trunk.pull(repo.id, w);
    let noted: LandMark | undefined;
    await withRepoLock(repo.path, async () => {
      // A PR goes on the record once, since the record is what says it was taken, and always:
      // the trunk's own fetch often moves the base before the poll sees the merge, and a merge
      // that kept the hashes leaves no range against it. Then the branch's own commits by its
      // reflog, else the tip alone. A press with no PR behind it records a range or nothing,
      // so a second press over a landed row adds no entry.
      if (!prTaken(wt)) {
        const own = read ?? (await handLanding(wt.path, wt.branch, base, wt.lands?.at(-1)?.tip));
        const mark = own ?? (wt.pr ? await this.tipMark(wt) : null);
        noted = await this.noteLand(repo, wt, mark, { pr: wt.pr });
      }
      // origin's main, fetched by the pull, whatever the checkout here could do with it
      await this.restartFromMain(wt, base);
    });
    this.invalidateCounts();
    const held = await this.settleLanded(wt);
    const took = pulled.ok
      ? `${br} here ${pulled.moved ? "pulled it" : "has it"}`
      : `${br} here was left where it is: ${pulled.message}`;
    return { ok: true, message: wt.pr ? `PR #${wt.pr.number} merged; ${took}` : took, mark: noted, held };
  }

  /** take main into any row with a branch, a found worktree included: a rebase for toyon's own
   * branch, a merge for one it found or adopted. The one git write allowed without take-over,
   * because there both refuse a dirty tree before touching it and abort on a conflict, so the
   * directory is left as it was found in every case but success. A worktree toyon runs is dirty as
   * a rule (its agent never commits), so there the uncommitted work is carried across the sync.
   * `by` says whose it is: a press moves the row up the rail, at the press, even when the sync
   * itself waits for the turn; the run after the turn is nobody's hand and moves nothing. */
  async sync(worktreeId: string, by: "press" | "auto" = "press"): Promise<{ result: ShipOutcome; base: string }> {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("that worktree is gone");
    if (r.wt && isMain(r.wt)) throw new UserError("sync from a worktree, not main");
    if (r.wt && isProvisional(r.wt))
      throw new UserError("the new worktree already sits on main; it follows it on its own");
    if (!r.branch) throw new UserError(`${r.name} is detached: check out a branch in it first`);
    if (r.locked) throw new UserError(`${r.name} is held by another tool`);
    const repo = this.d.state.requireRepo(r.repoId);
    const own = r.wt ? hasOwnBranch(r.wt) : false;
    const carry = !!r.wt;
    // Carrying empties the tree for a moment, and a file tool writing into that gap is lost under
    // the work put back; a clean tree has no such gap. So under a turn the press is kept and runs
    // when the turn settles, which is what the person pressing it now wants of it anyway.
    const busy = isBusy(this.d.runtime.agentFor(worktreeId)?.status);
    if (carry && busy && (await statusFiles(r.path)).length > 0) {
      this.syncQueued.add(worktreeId);
      if (by === "press") this.stampPrompted(worktreeId);
      this.d.hub.emit("worktreesChanged");
      return { result: { ok: true, message: `${r.name} syncs from ${r.base} once the turn ends` }, base: r.base };
    }
    // a found worktree has no chat for the rows to go on
    const w = r.wt ? this.landWatch(r.wt) : UNWATCHED;
    const result = await this.ship(worktreeId, "sync-main", by, async () => {
      // the base as it is now, not as of the last fetch: outside the lock, since the fetch
      // holds the network for seconds and touches no checkout
      if (r.wt) {
        const fetched = await this.fetchBase(r.wt, repo, w);
        if (!fetched.ok) return fetched;
      }
      // marked before the move: a read out across it answers for the tree before, and is dropped
      this.tree.invalidate(worktreeId);
      const taken = await withRepoLock(repo.path, () => takeMainIn(r.path, r.base, own, w, carry));
      if (taken.ok) {
        await this.headMoved(worktreeId);
        // the same work over a newer base: the sentence and the message still describe it
        if (r.wt) await this.verdictSurvives(r.wt, { dropMessage: false });
      }
      return taken;
    });
    return { result: r.wt ? this.fixShip(r.wt, result, r.base) : result, base: r.base };
  }

  /** the sync waiting for the turn to end, taken back */
  unqueueSync(worktreeId: string): void {
    if (!this.syncQueued.delete(worktreeId)) return;
    this.d.hub.emit("worktreesChanged");
  }

  /** The turn a queued sync waited for is over. The queue is held here, inside the status
   * dispatch, so a message sent meanwhile waits for the sync rather than start a turn under the
   * carry; the op's own hold takes over once the sync is out, and the count lets this one go.
   * Nobody pressed this, so a failure is said on the chat the way a daemon's own is. */
  private syncAfterTurn(worktreeId: string): void {
    if (!this.syncQueued.has(worktreeId)) return;
    // an op still out on the row (a commit or land pressed under the turn) would refuse a second:
    // the press keeps, and the op's own end runs it
    if (this.ops.has(worktreeId)) return;
    this.syncQueued.delete(worktreeId);
    const release = this.d.runtime.agentFor(worktreeId)?.hold();
    this.d.hub.emit("worktreesChanged");
    fireAndForget(
      worktreeId,
      (async () => {
        try {
          const { result } = await this.sync(worktreeId, "auto");
          if (!result.ok && !result.asked) this.d.hub.emit("failed", worktreeId, result.message);
        } catch (e) {
          this.d.hub.emit("failed", worktreeId, e instanceof Error ? e.message : String(e));
        } finally {
          release?.();
        }
      })(),
      "sync after the turn",
    );
  }

  /** Fast-forward main to its upstream, the trunk's own way (a fetch, then the fast-forward under
   * the lock, the fetch on the record); under a local base every worktree's `behind` moves with
   * it. Never a merge: a main that has diverged from origin is a decision for a terminal, not a
   * button. Uncommitted files on main are git's to judge, at the fast-forward: only one it would
   * overwrite refuses it, named. */
  async pull(worktreeId: string): Promise<ShipResult> {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (!isMain(wt)) throw new UserError("pull on main; a worktree syncs from main instead");
    const repo = this.d.state.requireRepo(wt.repoId);
    // main has no chat for git's rows, so the pull's steps are named and nothing more
    const w: LandWatch = { step: (name) => this.step(worktreeId, name), git: UNWATCHED.git };
    return this.ship(worktreeId, "pull-main", "auto", async () => {
      const result = await this.trunk.pull(repo.id, w);
      // main moved under every row: the op's closing frame carries all of them read again
      if (result.ok && result.moved) await this.recountAll();
      return result;
    });
  }

  async commit(worktreeId: string, message: string): Promise<ShipOutcome> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const m = message.trim();
    if (!m) throw new UserError("commit message required");
    const base = baseOf(this.d.state.requireRepo(wt.repoId));
    return this.fixShip(wt, await this.ship(wt.id, "commit", "press", () => this.commitRecorded(wt, m)), base);
  }

  /** stored, not cached: the first frame of a page load reads it before git has been asked */
  private setEmpty(wt: WorktreeInfo, empty: boolean) {
    if (wt.empty === empty) return;
    wt.empty = empty;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the plus was opened: the trunk fetches and, clean and behind, takes origin in (Trunk.sync) */
  syncTrunk(repoId: string): Promise<void> {
    return this.trunk.sync(repoId);
  }

  /** every project's trunk as it stands (Trunk.all), with the op running on it */
  private trunksNow(): Record<string, TrunkStatus> {
    const all = this.trunk.all();
    for (const t of Object.values(all)) {
      const shipping = this.ops.get(t.id);
      if (shipping) t.shipping = shipping;
    }
    return all;
  }

  /** the figures for a row: what the stream said last, else what the transcript on disk ends with */
  private usageFor(worktreeId: string): WorktreeStatus["usage"] | undefined {
    const known = this.usage.get(worktreeId);
    if (known !== undefined) return known ?? undefined;
    const found = lastUsage(transcriptPathFor(this.d.paths.transcriptsDir, worktreeId));
    this.usage.set(worktreeId, found);
    return found ?? undefined;
  }

  /** the row's HEAD moved under an op: its numbers are read again before the frame that says so,
   * so the rail never shows the count the person just acted on */
  private async headMoved(worktreeId: string) {
    await this.tree.refresh(worktreeId);
    this.d.hub.emit("worktreesChanged");
  }

  /** main moved under every row, for the frame of the op that moved it: all of them read again
   * now, a few at a time under the owner's slots, until none is left */
  private async recountAll() {
    this.tree.invalidateAll();
    for (;;) {
      const reading = this.tree.refreshStale(this.countedIds());
      if (!reading) return;
      await reading;
    }
  }

  // ---- queries ----

  /** badge counts are stale: every row's when the default branch moved, one worktree's when only
   * its own files did. The numbers stand until the next frame has them read again. */
  invalidateCounts(worktreeId?: string) {
    if (worktreeId) this.tree.invalidate(worktreeId);
    else this.tree.invalidateAll();
  }

  /** Files may have changed where toyon could not see them (another app, while the window was
   * behind it): the same refresh as the default branch moving, every row recounted and every open
   * changes list re-read. */
  recount(repoId: string) {
    this.tree.invalidateAll();
    this.d.hub.emit("repoTick", repoId);
    // the rows count against origin's main, so the window coming back is when to ask origin
    // again; the trunk fetches once a minute at most
    const repo = this.d.state.repo(repoId);
    if (repo && baseIsRemote(repo)) fireAndForget(repoId, this.trunk.sync(repoId), "trunk sync");
  }

  /** something under `.git/worktrees` changed: git's list is no longer what we last read. The
   * last list stands until it is read again, so a row on screen still answers by id meanwhile. */
  invalidateDiscovered() {
    this.listMark++;
    for (const cached of this.discoverCache.values()) cached.at = 0;
  }

  /** A discovered row by id, from the last list only: no git, no await.
   *
   * The terminal opens inside one synchronous block on purpose (see the `term-open` handler), so
   * this cannot shell out. Reading the cache is honest here because the person can only click a
   * row that was pushed to them, and every push is this list as it stood. */
  discoveredById(id: string): FoundWorktree | null {
    return this.foundCached().find((r) => r.id === id) ?? null;
  }

  /** Worktrees git knows about that toyon does not, across every registered repo: the list as
   * last read, read again first for a repo not asked within the floor. */
  async discovered(): Promise<FoundWorktree[]> {
    await this.relist(this.d.state.repos.filter((repo) => this.listDue(repo.id)));
    return this.foundCached();
  }

  /** the found rows as last listed, with the repos not asked within the floor listed again behind
   * the frame; one frame follows if a list moved */
  private foundNow(): FoundWorktree[] {
    const due = this.d.state.repos.filter((repo) => this.listDue(repo.id));
    if (due.length) this.behind("discover", this.relist(due), "worktree list");
    return this.foundCached();
  }

  /** the found rows as last listed, less any taken over since: a frame never shows a worktree
   * twice, as toyon's and as found, however long the list takes to be read again */
  private foundCached(): FoundWorktree[] {
    const owned = new Set(this.d.state.worktrees.flatMap((w) => [w.id, w.path]));
    return this.d.state.repos.flatMap((repo) =>
      (this.discoverCache.get(repo.id)?.rows ?? []).filter((r) => !owned.has(r.id) && !owned.has(r.path)),
    );
  }

  /** A frame goes out on every proc event, and a dev-server log
   * line should not shell out to git. The watcher marks the list stale when a worktree actually
   * appears or goes, so the floor bounds how often we ask when nothing has happened, not how long
   * a real change stays invisible. */
  private listDue(repoId: string): boolean {
    const cached = this.discoverCache.get(repoId);
    return !cached || Date.now() - cached.at >= LIST_FLOOR_MS;
  }

  /** git's list for each repo named, one listing per repo at a time; true when any list moved */
  private async relist(repos: RepoInfo[]): Promise<boolean> {
    const moved = await Promise.all(
      repos.map((repo) => {
        const running = this.relisting.get(repo.id);
        if (running) return running;
        const listing = (async () => {
          const cached = this.discoverCache.get(repo.id);
          try {
            for (;;) {
              const mark = this.listMark;
              const rows = await discoverIn(repo.id, repo.path, this.d.state.worktrees);
              // the watcher fired again while git was listing (a worktree add writes its files
              // over several events): that list is from before it, so list again
              if (mark !== this.listMark) continue;
              this.discoverCache.set(repo.id, { rows, at: Date.now() });
              // a first list that finds nothing is no move: the frame already showed no found rows
              return JSON.stringify(cached?.rows ?? []) !== JSON.stringify(rows);
            }
          } catch (e) {
            log.warn(repo.id, "could not list this repo's worktrees", e);
            return false;
          } finally {
            this.relisting.delete(repo.id);
          }
        })();
        this.relisting.set(repo.id, listing);
        return listing;
      }),
    );
    // a shell at a directory that is no longer a discovered worktree has nothing to belong to: it
    // was taken over (its worktree runs a real shell now), removed, or its repo was forgotten
    this.d.runtime.pruneLooseShells(new Set(this.foundCached().map((r) => r.id)));
    const any = moved.some(Boolean);
    if (any) this.d.hub.emit("worktreesChanged");
    return any;
  }

  /** a worktree's dirty files and commits ahead of main, from git now rather than the rail's cached
   * counts: what an archive of its own accord is decided on. Empty when git cannot say. */
  async freshCounts(worktreeId: string): Promise<{ ahead?: number; dirty?: number }> {
    // a tree being removed has no numbers to decide on: the last ones are the work that is leaving
    if (this.going.has(worktreeId)) return {};
    const rec = await this.tree.refresh(worktreeId);
    if (!rec || rec.failedAt !== undefined) return {};
    return { ...(rec.core.ahead === undefined ? {} : { ahead: rec.core.ahead }), dirty: rec.core.files.length };
  }

  /** Resolve an id for reading: a worktree toyon runs, the spare included (it is the row new work
   * is typed in, and its checkout is what that row shows), or one toyon merely knows about. Null
   * for an id that is neither. */
  readable(id: string): ReadableWorktree | null {
    const wt = this.d.state.worktree(id);
    if (wt) {
      const repo = this.d.state.requireRepo(wt.repoId);
      return {
        id,
        repoId: wt.repoId,
        path: wt.path,
        name: wt.title,
        branch: wt.branch,
        defaultBranch: repo.defaultBranch,
        base: baseOf(repo),
        wt,
      };
    }
    const disc = this.discoveredById(id);
    const repo = disc && this.d.state.repo(disc.repoId);
    if (!disc || !repo) return null;
    return {
      id,
      repoId: disc.repoId,
      path: disc.path,
      name: disc.name,
      branch: disc.branch,
      locked: disc.locked,
      defaultBranch: repo.defaultBranch,
      base: baseOf(repo),
    };
  }

  /** Where the row's work stands as a message goes out, for the paragraph behind it (agent/prompt.ts
   * standingContext). The tree is read now rather than taken from the last record: a commit from
   * the box, a land, or an edit by hand a moment ago is what the agent must hear, and a read
   * joins one already in flight. The marks come off the record, which the same read keeps. */
  async standing(worktreeId: string): Promise<WorkStanding | null> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "spare" || this.going.has(worktreeId)) return null;
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return null;
    const rec = (await this.tree.refresh(worktreeId)) ?? this.tree.get(worktreeId);
    const core = rec?.core;
    const last = wt.lands?.at(-1);
    const pr = prStanding(wt);
    return {
      main: wt.kind === "main",
      base: baseOf(repo),
      ...(core ? { dirty: core.files.length } : {}),
      ...(core?.ahead === undefined ? {} : { ahead: core.ahead }),
      ...(core?.behind === undefined ? {} : { behind: core.behind }),
      ...(core?.unpushed === undefined ? {} : { unpushed: core.unpushed }),
      ...(wt.landed
        ? { landed: { subjects: last?.subjects ?? [], ...(last?.pr === undefined ? {} : { pr: last.pr }) } }
        : {}),
      ...(pr
        ? {
            pr: {
              number: pr.number,
              url: pr.url,
              state: pr.state,
              ...(pr.checks ? { checks: pr.checks } : {}),
              ...(pr.review ? { review: pr.review } : {}),
              ...(pr.automerge ? { automerge: pr.automerge } : {}),
              ...(pr.queued ? { queued: pr.queued } : {}),
            },
          }
        : {}),
    };
  }

  /** A turn is starting on this worktree: keep the tree it starts from, so the changes panel can
   * say what the turn itself wrote. */
  async turnStarted(worktreeId: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (wt && !this.going.has(worktreeId)) await markTurn(wt.path, wt.id);
  }

  /** The record side effects of a tree read the owner accepted (worktrees/treeState.ts): the
   * branch the checkout is on, a landing git did without toyon, the PR and landed marks (the one
   * place the `landed` badge is cleared: new work after a merge means it is no longer landed),
   * the verdict's fingerprint, main's empty flag. True when they moved the tree, so the owner
   * reads it once more before anything is published. */
  private async afterCore(r: ReadableWorktree, core: TreeCore): Promise<boolean> {
    const wt = r.wt;
    if (!wt) return false;
    // an op out on the row (a land, a sync) reads the tree between its own git steps, with the
    // checkout mid-way through them: a temporary branch is not the row's, and the marks are the
    // op's own to set when it settles
    if (this.ops.has(wt.id)) return false;
    const isMain = wt.kind === "main";
    if (core.branch) await this.followBranch(wt, core.branch);
    const { files, head } = core;
    const ahead = core.ahead ?? 0;
    // a landing git did without toyon: the branch is clean and level with the base and has
    // commits of its own since its last landing. Asked once per HEAD, and before the landed
    // mark is read, since a second hand landing over a first leaves the row landed by the rule
    // while its range is still unrecorded; the land press and a PR merge mark their own.
    if (
      !isMain &&
      hasOwnBranch(wt) &&
      files.length === 0 &&
      ahead === 0 &&
      head &&
      this.handChecked.get(wt.id) !== head
    ) {
      this.handChecked.set(wt.id, head);
      const mark = await handLanding(r.path, wt.branch, r.base, wt.lands?.at(-1)?.tip);
      if (mark) {
        await this.landedByHand(wt, mark);
        return true;
      }
    }
    if (!isMain && head) {
      const facts = { head, ahead };
      // committed work past a merged PR is a new PR later; the old one is history. An edit
      // alone is not: it may be discarded, and the PR was taken either way.
      if (prTaken(wt) && movedPastLand(wt, facts)) this.setPr(wt.id, undefined);
      await this.refreshLanded(wt, facts);
    }
    // a verdict describes one tree: an edit since (by hand, by another tool) marks it stale, so
    // the composer keeps the sentence and the message but withholds the word until the check
    // runs again. A tree that comes back to what the verdict saw (an edit undone) clears the mark.
    const landing = wt.landing;
    if (landing && landing.check !== "pending") {
      const moved = landing.fingerprint !== (await this.fingerprint(r.path));
      // the verdict moved or went while the tree was being read: the next poll judges the new one
      if (wt.landing === landing && moved !== !!landing.stale) {
        const { stale: _was, ...rest } = landing;
        this.setLanding(wt.id, moved ? { ...rest, stale: true } : rest);
      }
    }
    // the empty-tree fact lives on main's record, so the rows frame carries it without git: a
    // task worktree of an empty repo is not the greenfield surface, so only main keeps it
    if (isMain) this.setEmpty(wt, files.length === 0 ? await treeEmpty(r.path) : false);
    return false;
  }

  /** the worktree's whole git state read now, the panel's tier included whether or not anyone is
   * subscribed: for a decision, or a test, that needs it as it stands. The frames the panel gets
   * come from the owner's own reads (treeState.ts); this sends none, only the rail's. */
  async gitStatus(worktreeId: string): Promise<GitInfo | null> {
    if (!this.readable(worktreeId)) return this.archivedStatus(worktreeId);
    const { frame, moved } = await this.tree.full(worktreeId);
    // a fresher count than the rows carry: the row takes it now, not at the next frame
    if (moved) this.d.hub.emit("worktreesChanged");
    return frame;
  }

  /** every id a move of the repo's main concerns: its rows, the worktrees found in it, its trunk */
  private rowsOf(repoId: string): string[] {
    const ids = this.d.state.worktrees.filter((wt) => wt.repoId === repoId && this.isRow(wt)).map((wt) => wt.id);
    for (const f of this.foundCached()) if (f.repoId === repoId) ids.push(f.id);
    const main = this.mainOf(repoId);
    if (main && !ids.includes(main.id)) ids.push(main.id);
    return ids;
  }

  /** the history tab's commit list. Unlike gitStatus this is asked for, not pushed: the panel
   * requests it when the tab is opened and after a commit, so a worktree nobody is reviewing
   * never pays for it. */
  async gitLog(worktreeId: string): Promise<CommitEntry[]> {
    const r = this.readable(worktreeId);
    if (r) return logCommits(r.path, r.base);
    return (await this.archivedGit(worktreeId)?.log()) ?? [];
  }

  /** the files one commit touched, on expanding it in the history tab */
  async commitFiles(worktreeId: string, sha: string): Promise<GitFileStatus[]> {
    const r = this.readable(worktreeId);
    if (r) return readCommitFiles(r.path, sha);
    return (await this.archivedGit(worktreeId)?.commitFiles(sha)) ?? [];
  }

  /** The agent actions want a worktree toyon runs. One it merely found in git has a row and a pane
   * like the others, so the refusal names the way out rather than calling the worktree unknown. */
  requireRun(worktreeId: string): WorktreeInfo {
    if (!this.d.state.worktree(worktreeId) && this.readable(worktreeId)) {
      throw new UserError("Toyon does not run this worktree: take it over first");
    }
    return this.d.state.requireWorktree(worktreeId);
  }

  /** a live worktree's chat file, once the first message has put it on disk: the row carries it
   * so the menu can offer it, and offers nothing before, since Finder shows nothing for a path
   * that is not there. A stat per row per push, which is cheap beside the usage read next to it. */
  private writtenTranscript(worktreeId: string): string | undefined {
    const path = transcriptPathFor(this.d.paths.transcriptsDir, worktreeId);
    return existsSync(path) ? path : undefined;
  }

  /** the chat's file on disk, for a Finder reveal: a live worktree's, or the archive's once the
   * chat moved there, since an archive keeps its worktree's id. The shell offers the row only
   * when the status carried a file, so a refusal here is the safety net for a race with the
   * first message or an archive that moved under it. */
  transcriptPath(id: string): string {
    const path = this.d.state.worktree(id) ? this.writtenTranscript(id) : this.archive.chatFiles(id)?.transcript;
    if (!path || !existsSync(path)) throw new UserError("nothing has been written to this chat yet");
    return path;
  }

  /** A message typed into a worktree's box. A worktree archived under it, a moment ago or
   * mid-send, comes back with the message as its first, the way one typed on its archived page
   * does; otherwise the agent gets it and the row is stamped as prompted. */
  async send(
    worktreeId: string,
    msg: { text: string; clientId?: string; context?: string[]; attachments?: AttachmentInput[] },
  ): Promise<void> {
    await this.archivingNow(worktreeId);
    if (!this.d.state.worktree(worktreeId) && this.hasArchived(worktreeId)) {
      await this.restore(worktreeId, msg.clientId, {
        text: msg.text,
        attachments: msg.attachments,
        context: msg.context,
      });
      return;
    }
    const wt = this.requireRun(worktreeId);
    // the shell starts new work from the plus, never here; a client that names main by hand is
    // refused the same way, so no agent turn ever runs in the main checkout
    if (wt.kind === "main") throw new UserError("nothing runs on main: the plus starts a worktree for it");
    // typed into a row whose first message is still on its way to the queue: this one goes behind
    // it, in the order they were sent
    await this.firstPrompt.get(worktreeId);
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    agent.send(msg.text, { context: msg.context, attachments: msg.attachments });
    // the stamp the rail sorts on; its frame also carries the queued count the send may have changed
    this.markPrompted(worktreeId);
  }

  /** someone sent something here, a chat message or a `!` command: the rail sorts on it */
  markPrompted(worktreeId: string) {
    if (this.stampPrompted(worktreeId)) this.d.hub.emit("worktreesChanged");
  }

  /** the stamp alone, for a caller whose own frame carries it */
  private stampPrompted(worktreeId: string): boolean {
    const wt = this.d.state.worktree(worktreeId);
    // a discovered worktree has no record, and the rail keeps those in a section of their own
    if (!wt) return false;
    wt.promptedAt = Date.now();
    this.d.state.save();
    return true;
  }

  /** The frame's worth: every row the rail shows, toyon's own worktrees in state order then the
   * ones git knows about that toyon did not create, and each project's trunk beside them. Nothing
   * here waits on git: the numbers and the found list are as last read, and what is older than
   * the floor is read again behind the frame, which sends one of its own if something moved. So a
   * frame costs what it costs to assemble, whatever the rail's size, and a send moves its row at
   * the press. */
  snapshot(): { rows: WorktreeStatus[]; trunks: Record<string, TrunkStatus> } {
    const rows = [...this.ownedRows(), ...this.foundRows()];
    const trunks = this.trunksNow();
    const reading = this.tree.refreshStale(idsOf(rows, trunks));
    if (reading) {
      this.behind(
        "tree",
        reading.then((moved) => {
          if (moved) this.d.hub.emit("worktreesChanged");
        }),
        "badge counts",
      );
    }
    return { rows, trunks };
  }

  /** the rows half of the frame (snapshot) */
  rows(): WorktreeStatus[] {
    return this.snapshot().rows;
  }

  /** the trunks half of the frame (snapshot) */
  trunks(): Record<string, TrunkStatus> {
    return this.snapshot().trunks;
  }

  /** every row and trunk a frame carries numbers for */
  private countedIds(): string[] {
    return idsOf([...this.ownedRows(), ...this.foundCached()], this.trunksNow());
  }

  /** a read set off behind a frame, kept until it and the frame it may send are done */
  private behind(tag: string, read: Promise<unknown>, what: string) {
    this.pending.add(read);
    const done = () => this.pending.delete(read);
    read.then(done, done);
    fireAndForget(tag, read, what);
  }

  /** every read a frame set off, counts and found list alike, and the frames they send: for a
   * decision, or a test, that needs them as they stand. True when there was something to wait on. */
  async settled(): Promise<boolean> {
    let waited = false;
    for (;;) {
      if (this.pending.size) {
        waited = true;
        await Promise.all(this.pending);
        continue;
      }
      if (await this.tree.settled()) {
        waited = true;
        continue;
      }
      return waited;
    }
  }

  private mainOf(repoId: string): WorktreeInfo | undefined {
    return mainOf(this.d.state, repoId);
  }

  /** the spare the pool counts as the repo's: the row new work is typed in. An extra spare record
   * adopt() is still pruning, and one the pool has let go of, are nobody's. */
  private leadSpareOf(repoId: string): string | null {
    return this.spare.current(repoId)?.worktreeId ?? null;
  }

  /** Whether a record is a rail row. A task always is. The repo's spare is, as the row new work
   * is typed in, from the moment it is reserved; main is one only while the repo has no spare to
   * stand in for it (setup unconfirmed, an empty project, a warm-up that failed), so the first-run
   * screens and the setup pane keep a row to sit on. A stale extra spare being pruned is nobody's. */
  private isRow(wt: WorktreeInfo): boolean {
    if (wt.kind === "worktree") return true;
    const lead = this.leadSpareOf(wt.repoId);
    return wt.kind === "spare" ? lead === wt.id : lead === null;
  }

  private ownedRows(): WorktreeStatus[] {
    return this.d.state.worktrees
      .filter((wt) => this.isRow(wt))
      .map((wt) => {
        const rt = this.d.runtime.get(wt.id);
        const { ahead, behind, unpushed, dirty } = this.tree.counts(wt.id) ?? {};
        const procs = rt?.procs?.states() ?? [];
        // a proc being set up here before its spawn has a tab of its own, so it is not drawn as
        // main's as well
        const live = new Set(procs.map((p) => p.name));
        const borrowed = this.d.runtime.borrowedStates(wt.id).filter((b) => !live.has(b.name));
        const remoteBehind = this.d.runtime.remoteBehind(wt.id);
        return {
          id: wt.id,
          repoId: wt.repoId,
          path: wt.path,
          name: wt.title,
          branch: wt.branch,
          worktree: wt,
          procs,
          borrowed: borrowed.length > 0 ? borrowed : undefined,
          remoteBehind: remoteBehind.length > 0 ? remoteBehind : undefined,
          agent: rt?.agent.status ?? "idle",
          stopping: rt?.agent.stopping || undefined,
          background: rt?.agent.holding || undefined,
          wakes: rt?.agent.wakes ?? undefined,
          login: !!rt?.login,
          ahead,
          behind,
          unpushed,
          dirty,
          queued: rt?.agent.queueLength || undefined,
          unseen: isUnseen(wt) || undefined,
          usage: this.usageFor(wt.id),
          transcript: this.writtenTranscript(wt.id),
          sessionId: this.d.state.session(wt.id),
          shipping: this.ops.get(wt.id),
          syncQueued: this.syncQueued.has(wt.id) || undefined,
        };
      });
  }

  private foundRows(): WorktreeStatus[] {
    return this.foundNow().map((f) => {
      const { ahead, behind, dirty } = this.tree.counts(f.id) ?? {};
      return {
        ...f,
        procs: [],
        agent: "idle" as const,
        login: false,
        ahead,
        behind,
        dirty,
        shipping: this.ops.get(f.id),
      };
    });
  }
}
