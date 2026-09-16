// Worktree lifecycle and landing: everything that decides what happens to a worktree. The
// transport layer (server/handlers.ts) calls in here and shapes replies; git/, runtime/ and the
// spare pool do the work.

import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type AgentEvent,
  type ArchivedWorktree,
  type AttachmentInput,
  type CommitEntry,
  canArchive,
  canGraft,
  canLand,
  canRename,
  DEFAULT_MERGE_METHOD,
  type GitFileStatus,
  hasOwnBranch,
  isMain,
  type Landing,
  landPolicy,
  type PermissionMode,
  type PrState,
  type RefKind,
  type RepoInfo,
  type SpareInfo,
  type WorktreeInfo,
  type WorktreeStatus,
} from "@toyon/shared";
import type { OptionField } from "../agent/acp/options.ts";
import { attachmentsDirFor, isAttachmentFile } from "../agent/attachments.ts";
import { canonical } from "../agent/bounds.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { makeNamer, taskText } from "../agent/tasks.ts";
import { coalesce, Transcript, type TranscriptEntry, transcriptPathFor } from "../agent/transcript.ts";
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
  type KeptState,
  keepState,
  type LandingRange,
  landingMark,
  landRef,
} from "../git/archive.ts";
import { GIT, git, gitOrThrow, NO_PROMPT, run } from "../git/exec.ts";
import {
  commitWorktree,
  fastForwardMain,
  landLocally,
  mergePr,
  openPr,
  pullMain,
  pushMain,
  type ShipResult,
  squashMessage,
  takeMainIn,
} from "../git/land.ts";
import { withRepoLock } from "../git/lock.ts";
import { logCommits, commitFiles as readCommitFiles } from "../git/log.ts";
import {
  aheadBehind,
  behindUpstream,
  committedFiles,
  statusFiles,
  statusFilesWithCounts,
  treeEmpty,
  treeFingerprint,
} from "../git/status.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { isInside } from "../repos/create.ts";
import { allocateProxyPort, releasePort } from "../runtime/ports.ts";
import { resolveRun } from "../runtime/profile.ts";
import { DEFAULT_AGENT_ID, type RuntimeRegistry, worktreeEnv } from "../runtime/registry.ts";
import { runSetup } from "../runtime/setup.ts";
import { type ArchiveRecord, type ChatFiles, firstPrompt, lastUsage, summarize, WorktreeArchive } from "./archive.ts";
import { ArchivedGit } from "./archivedGit.ts";
import { discoverIn, type FoundWorktree } from "./discover.ts";
import { cleanTitle, shortId, slugify, variantLens } from "./naming.ts";
import { SparePool } from "./spare.ts";
import { isUnseen } from "./turns.ts";

/** Gitignored local config a worktree needs and git will never bring over. Absent secrets fail
 * deep inside app code rather than as missing config (an empty AUTH_SECRET reads as a zero-length
 * HMAC key), so copy whatever the base checkout actually has. */
const LOCAL_CONFIG_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars"];

export type Variant = { group: string; index: number; of: number };

/** what a grafted transcript keeps of a message: its text. The source's attachment store goes with
 * the source, so a stored ref would point at nothing, and a pick numbered in the source's session
 * would put the numbers the shell draws on chips out of step with the target session's own. */
function withoutAttachments(event: AgentEvent): AgentEvent {
  if (event.type !== "user-message") return event;
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
  /** absent for a discovered worktree: there is nothing to mutate and nothing that owns it */
  wt?: WorktreeInfo;
}

/** what `git status` + ahead/behind say about one worktree */
export interface GitInfo {
  files: GitFileStatus[];
  committed?: GitFileStatus[];
  ahead?: number;
  behind?: number;
  /** HEAD's sha, so the history tab knows when its log went stale */
  head?: string;
}

/** what was typed into an archived chat, sent once the worktree is back */
export interface RestoreMessage {
  text: string;
  attachments?: AttachmentInput[];
}

export interface CreateOpts {
  /** the shell tab that asked; stored as createdBy so only that tab auto-focuses the result */
  createdBy?: string;
  /** registry id; the daemon's default when absent */
  agent?: string;
  variant?: Variant;
  /** paragraphs Toyon attaches behind the text, out of the transcript */
  context?: string[];
  /** in the order they were attached */
  attachments?: AttachmentInput[];
  /** one of the repo's profiles; the repo's default when absent */
  profile?: string;
  /** what the agent may do without asking; the default mode when absent */
  mode?: PermissionMode;
  /** one of the agent's advertised model ids; its default when absent */
  model?: string;
  /** one of the agent's advertised effort levels; its default when absent */
  effort?: string;
  /** move main's uncommitted changes into the new worktree before its agent starts */
  carry?: boolean;
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

export interface WorktreeServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  paths: Paths;
  agents: AgentRegistry;
  /** the unsent text in composer boxes: a worktree discarded or deleted from the archive takes its own */
  drafts?: Pick<DraftStore, "drop">;
  /** task → short kebab-case name (the worktree's own agent by default; tests inject a stub) */
  namer?: (prompt: string, wt: WorktreeInfo) => Promise<string | null>;
}

/** how often main's upstream is fetched while its row is being counted */
const FETCH_EVERY_MS = 5 * 60_000;

export class WorktreeService {
  readonly spare: SparePool;
  private archive: WorktreeArchive;
  /** archives under way, by worktree id: a click during a sweep joins the one already running */
  private archiving = new Map<string, Promise<ArchivedWorktree | null>>();
  private countsCache = new Map<string, { ahead?: number; behind?: number; dirty: number; at: number }>();
  /** per repo, because discovery asks git once for the whole repo rather than once per worktree */
  private discoverCache = new Map<string, { rows: FoundWorktree[]; at: number }>();
  /** the last usage figures per worktree: live from the stream, else read once from the transcript
   * on disk (null: read, and there were none) */
  private usage = new Map<string, WorktreeStatus["usage"] | null>();
  /** per repo path, when main's upstream was last fetched */
  private lastFetch = new Map<string, number>();

  constructor(private d: WorktreeServiceDeps) {
    this.archive = new WorktreeArchive(d.paths.archiveDir);
    this.spare = new SparePool({
      state: d.state,
      hub: d.hub,
      runtime: d.runtime,
      paths: d.paths,
      setupAndStart: (wt, repo) => this.setupAndStart(wt, repo),
      discard: async (id) => {
        await this.discardWorktree(id);
      },
    });
    // worktrees claimed before links existed get theirs at boot
    for (const wt of d.state.worktrees) this.refreshLink(wt);
    d.hub.on("agent", (worktreeId, _seq, event) => {
      if (event.type !== "usage") return;
      const { used, size, cost } = event;
      this.usage.set(worktreeId, { used, size, ...(cost !== undefined ? { cost } : {}) });
    });
    // turnSettled is emitted from inside the agentStatus dispatch, ahead of the ws layer's listener
    // on that event, so what is dropped here is gone before the status frame goes out
    d.hub.on("turnSettled", (worktreeId, turn) => {
      // what the turn wrote is the count the rail should show now, not whenever its cache runs out
      this.countsCache.delete(worktreeId);
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
    const { variant, context, attachments } = opts;
    const repo = this.d.state.requireRepo(repoId);
    // validated up front: an unknown or uninstalled agent is a refusal now, not a dead worktree later
    const agent = this.d.agents.require(opts.agent ?? this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id;
    const profile = this.checkProfile(repo, opts.profile);
    // a message that is attachments alone is named from what they carry
    const task = taskText(prompt, attachments);
    // variants share a name base so they read as siblings in the list
    let slug = variant ? `${slugify(task, false)}-v${variant.index}` : slugify(task);
    if (variant && (await git(repo.path, "show-ref", "--verify", `refs/heads/toyon/${slug}`)).ok) {
      slug = `${slug}-${shortId().slice(0, 3)}`;
    }
    const branch = `toyon/${slug}`;

    // one set of changes can only move once
    if (opts.carry && variant && variant.of > 1) {
      throw new UserError(`only a single worktree can take the changes on ${repo.defaultBranch}`);
    }

    // perspective-diverse variants: same goal, different emphasis per attempt
    const agentPrompt =
      variant && variant.of >= 2 ? [prompt, variantLens(variant.index)].filter(Boolean).join("\n\n") : prompt;

    // fast path: claim the pre-warmed spare. Its runtime — agent included — already exists, so the
    // task's first message goes to the spare's agent.
    const claimed = await this.spare.claim(repoId, branch, slug);
    if (claimed) {
      if (variant) claimed.variant = variant;
      if (opts.createdBy) claimed.createdBy = opts.createdBy;
      // made from a prompt, which is a send
      claimed.promptedAt = claimed.createdAt;
      // the spare's agent has no process yet; it reads the stamps on its first prompt
      claimed.agent = agent;
      if (opts.mode) claimed.mode = opts.mode;
      if (opts.model) claimed.model = opts.model;
      if (opts.effort) claimed.effort = opts.effort;
      this.refreshLink(claimed);
      // the spare was warmed under the default profile; another one means its procs restart
      // (the agent stays, and gets the prompt now rather than after the restart)
      if (profile !== undefined && profile !== resolveRun(repo, claimed).profile) {
        claimed.profile = profile;
        this.restartProcs(claimed, repo);
      }
      const carried = await this.carryMain(repo, claimed, !!opts.carry);
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      this.d.runtime
        .ensureAgent(claimed)
        .agent.send(agentPrompt, { context: withCarry(context, carried), attachments });
      this.scheduleNaming(claimed, task, variant);
      if (carried.unmoved) throw new UserError(carried.unmoved);
      return claimed;
    }

    const wtPath = join(this.d.paths.worktreesDir, repo.name, slug);
    await withRepoLock(repo.path, () =>
      gitOrThrow(repo.path, "worktree", "add", "-b", branch, wtPath, repo.defaultBranch),
    );

    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: wtPath,
      branch,
      kind: "worktree",
      proxyPort: await allocateProxyPort(),
      title: slug,
      createdAt: Date.now(),
      // made from a prompt, which is a send
      promptedAt: Date.now(),
      agent,
      ...(variant ? { variant } : {}),
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      ...(profile !== undefined ? { profile } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    };
    // before the setup reads the tree and before the agent's first look at it
    const carried = await this.carryMain(repo, wt, !!opts.carry);
    // setup + procs warm in the background; the agent starts immediately
    this.launch(wt, repo, repo.path);
    this.d.runtime.ensureAgent(wt).agent.send(agentPrompt, { context: withCarry(context, carried), attachments });
    this.scheduleNaming(wt, task, variant);
    if (carried.unmoved) throw new UserError(carried.unmoved);
    return wt;
  }

  /** What became of main's uncommitted work when a worktree was made from it. Asked to `move`, the
   * stash takes the changes (untracked files included) and clears main in one git step, so an edit
   * saved on main in the meantime is either in it or still on main, never lost between a read and a
   * clean; the stash is applied in the new worktree and dropped. A stash that will not apply goes
   * back onto main, which it came off cleanly, and the worktree starts without it, with `unmoved`
   * saying why for the person. Not asked to move, the files are only counted, so the agent can be
   * told they were left behind on purpose. */
  private async carryMain(repo: RepoInfo, wt: WorktreeInfo, move: boolean): Promise<Carried> {
    const main = repo.defaultBranch;
    if (!move) return { branch: main, moved: false, count: (await statusFiles(repo.path)).length };
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
      const applied = await git(wt.path, "stash", "apply", sha);
      if (applied.ok) {
        const ref = await entry();
        if (ref) await git(repo.path, "stash", "drop", ref);
        return undefined;
      }
      log.warn(wt.id, `moving ${main}'s changes failed`, applied.err);
      await git(wt.path, "reset", "--hard");
      await git(wt.path, "clean", "-fd");
      const ref = await entry();
      const back = ref ? await git(repo.path, "stash", "pop", ref) : null;
      return back?.ok
        ? `the changes on ${main} did not apply in ${wt.title}, so they stayed on ${main}`
        : `the changes on ${main} did not apply in ${wt.title}; they are kept in git stash as "toyon: into ${wt.title}"`;
    });
    // main's count in the rail is cached; it is clean now, or back to what it was
    const mainWt = this.d.state.worktrees.find((w) => w.repoId === repo.id && w.kind === "main");
    if (mainWt) this.countsCache.delete(mainWt.id);
    return { branch: main, moved: count > 0 && !unmoved, count, unmoved };
  }

  /** the record goes in, the rail hears about it, and the slow part (a deps clone, setup
   * commands, the procs) runs behind; RuntimeRegistry.start emits worktreesChanged again once the
   * procs are up. The one step create, take-over and opening a ref all share. */
  private launch(wt: WorktreeInfo, repo: RepoInfo, depsSource: string, opts: { setupCommands?: boolean } = {}) {
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
    const title = kind === "pr" ? `pr-${number}` : cleanTitle(ref) || "branch";
    let slug = title;
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
  private async requireDiscovered(repoId: string, repoPath: string, target: string): Promise<FoundWorktree> {
    const rows = await discoverIn(repoId, repoPath, this.d.state.worktrees);
    const found = rows.find((r) => canonical(r.path) === target);
    if (!found) throw new UserError("that worktree is gone, or Toyon already has it");
    return found;
  }

  /** Promote a worktree git knows about into one toyon runs.
   *
   * The directory already exists and someone else made it, so this allocates a port, records it and
   * starts the procs. It deliberately does not run the settings' setup commands (see
   * `setupAndStart`) and does not start an agent: take-over is not a task, and the agent comes up
   * on the first message like it does anywhere else. */
  async adopt(worktreeId: string, createdBy?: string): Promise<WorktreeInfo> {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("that worktree is gone");
    if (r.wt) throw new UserError(`Toyon already runs ${r.name}`);
    const repoId = r.repoId;
    const repo = this.d.state.requireRepo(repoId);
    const target = canonical(r.path);
    // the whole verify-then-record step holds the lock: outside it this races `worktree remove`
    // and leaves a record pointing at a directory that is already gone
    const wt = await withRepoLock(repo.path, async () => {
      const found = await this.requireDiscovered(repoId, repo.path, target);
      if (found.locked) {
        throw new UserError(`${found.name} is held by another tool${found.lockReason ? `: ${found.lockReason}` : ""}`);
      }
      // land, ship, merge and rename all address a branch; a detached worktree has none to name
      if (!found.branch) throw new UserError(`${found.name} is detached: check out a branch in it first`);
      // procs and a dep clone inside the main checkout would land in its working tree, where the
      // agent's file tools and git status would both start seeing them
      const enclosing = [...this.d.state.repos, ...this.d.state.worktrees].find((r) =>
        isInside(target, canonical(r.path)),
      );
      if (enclosing) throw new UserError(`${found.name} sits inside ${enclosing.path}, which Toyon already manages`);
      const rec: WorktreeInfo = {
        id: shortId(),
        repoId,
        path: found.path,
        branch: found.branch,
        kind: "worktree",
        proxyPort: await allocateProxyPort(),
        title: found.name,
        createdAt: Date.now(),
        agent: this.d.agents.require(this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id,
        ...(createdBy ? { createdBy } : {}),
      };
      return rec;
    });
    this.invalidateDiscovered();
    // slow, and nothing above depends on it: outside the lock, like create()'s own setup
    this.launch(wt, repo, repo.path, { setupCommands: false });
    return wt;
  }

  /** a profile name the repo actually has, or undefined for "the default"; a typo is a refusal */
  private checkProfile(repo: RepoInfo, name: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    if (!repo.config.profiles?.[name]) throw new UserError(`no profile "${name}" in ${repo.configFile}`);
    return name;
  }

  /** procs and proxy come back under the worktree's current profile; the agent is untouched */
  private restartProcs(wt: WorktreeInfo, repo: RepoInfo) {
    fireAndForget(
      wt.id,
      this.d.runtime.stopProcs(wt.id).then(() => this.d.runtime.start(wt, repo)),
      "profile restart",
    );
  }

  /** Run this worktree under another of the repo's profiles. Only its procs restart. */
  setProfile(worktreeId: string, name: string) {
    const { wt, repo } = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (wt.kind === "spare") throw new UserError("no profile for a spare worktree");
    const profile = this.checkProfile(repo, name);
    if (profile === wt.profile) return;
    wt.profile = profile;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    this.restartProcs(wt, repo);
  }

  /** what the agent may do here without asking. Nothing restarts: the session reads the record
   * before its next turn and every permission request, so it holds from the next prompt on. */
  setMode(worktreeId: string, mode: PermissionMode) {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (wt.kind === "spare") throw new UserError("no mode for a spare worktree");
    if (wt.mode === mode) return;
    wt.mode = mode;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** which of its models the agent runs here, from the next turn on. An empty id means its own
   * default. Not checked against the list: the agent is the authority and ignores an id it has
   * not got, and the session-info in the transcript says what actually ran. */
  setModel(worktreeId: string, model: string) {
    this.setOption(worktreeId, "model", model);
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

  /** Async pretty-naming: solo worktrees rename directly; variant groups rename together
   * (index 1 runs the Haiku call, then every sibling becomes <name>-v<index>). */
  private scheduleNaming(wt: WorktreeInfo, prompt: string, variant?: Variant) {
    // nothing to name from: the slug stays rather than a name made up from an empty task
    if (!prompt.trim()) return;
    if (!variant) {
      fireAndForget(
        wt.id,
        (this.d.namer ?? makeNamer(this.d.runtime))(prompt, wt).then((name) => {
          if (name) return this.rename(wt.id, name);
        }),
        "auto-naming",
      );
      return;
    }
    if (variant.index !== 1) return; // sibling 1 names the whole group
    fireAndForget(
      wt.id,
      (this.d.namer ?? makeNamer(this.d.runtime))(prompt, wt).then(async (name) => {
        if (!name) return;
        for (const sibling of this.d.state.worktrees.filter((w) => w.variant?.group === variant.group)) {
          await this.rename(sibling.id, `${name}-v${sibling.variant!.index}`).catch((e) => {
            log.warn(sibling.id, "variant rename failed", e);
          });
        }
      }),
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

  private async takeDown(wt: WorktreeInfo, archive: boolean, reason?: string): Promise<ArchivedWorktree | null> {
    const worktreeId = wt.id;
    const repo = this.d.state.requireRepo(wt.repoId);
    // the agent first (inside runtime.stop): it may be mid-turn in the directory about to be
    // deleted, and its session-info callback would re-add the session entry removed below
    await this.d.runtime.stop(worktreeId);
    const kept = await withRepoLock(repo.path, async () => {
      // before the directory goes: its uncommitted work exists nowhere else. Nothing kept means
      // nothing goes: the branch is deleted on the strength of the ref holding its commits, and a
      // sweep runs with nobody watching, so the row stays and says why. The runtime is already
      // down, which is what an idle row looks like; a look at it wakes it.
      const k = archive ? await this.keep(repo, wt) : null;
      if (archive && !k) throw new UserError(`could not keep ${wt.title}'s work, so it was left in place`);
      await gitOrThrow(repo.path, "worktree", "remove", "--force", wt.path);
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
    this.dropLink(wt);
    const sessionId = this.d.state.session(worktreeId);
    this.d.state.removeWorktree(worktreeId);
    releasePort(wt.proxyPort);
    let archived: ArchivedWorktree | null = null;
    if (archive) archived = this.archiveChat(wt, repo, kept, sessionId, reason);
    else {
      this.deleteChat(worktreeId);
      // nothing will list what it landed, so nothing needs those commits kept
      if (wt.lands?.length) await dropLandRefs(repo.path, worktreeId);
    }
    this.d.hub.emit("worktreesChanged");
    return archived;
  }

  /** a worktree's commits and uncommitted work, under its archive ref, before its directory goes */
  private async keep(repo: RepoInfo, wt: WorktreeInfo): Promise<KeptState | null> {
    const index = join(this.d.paths.archiveDir, `${wt.id}.index`);
    const kept = await keepState(repo.path, wt.path, archiveRef(wt.id), index);
    if (!kept) log.warn(wt.id, "could not keep its git state");
    else if (kept.lost) log.warn(wt.id, "could not keep its uncommitted changes: only its commits are archived");
    return kept;
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
    const files = this.chatFiles(wt.id);
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
    try {
      this.archive.put(rec, files);
    } catch (e) {
      log.warn(wt.id, "could not archive its chat; the files stay where they were", e);
      return null;
    }
    this.d.hub.emit("archiveChanged", repo.id);
    return summarize(rec, repo.id);
  }

  private chatFiles(worktreeId: string): ChatFiles {
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
    this.dropLink(wt);
    this.d.state.removeWorktree(wt.id);
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

  /** whether the archive holds this id */
  hasArchived(archiveId: string): boolean {
    return !!this.archive.get(archiveId);
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
    return files ? new Transcript(files.transcript, archiveId).entries : null;
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
    return new ArchivedGit(repo.path, rec.kept, rec.worktree.lands ?? [], repo.defaultBranch);
  }

  /** what an archived worktree left, for the changes panel on its page; nothing is on disk, so
   * nothing is counted */
  private async archivedStatus(archiveId: string): Promise<GitInfo | null> {
    const kept = this.archivedGit(archiveId);
    if (!kept) return null;
    try {
      return await kept.status();
    } catch (e) {
      log.warn(archiveId, "reading its kept changes failed", e);
      return null;
    }
  }

  /** a file on an archived worktree's page: a commit's copy with `ref`, else what never landed
   * against where it forked. Null when no archive with kept commits has the id. */
  async archivedFile(archiveId: string, path: string, ref?: string): Promise<{ before: string; after: string } | null> {
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
   * into the archived chat: it goes to the agent the way a new worktree's first one does. */
  async restore(archiveId: string, createdBy?: string, message?: RestoreMessage): Promise<WorktreeInfo> {
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
    const path = existsSync(old.path)
      ? join(dirname(old.path), `${basename(old.path)}-${shortId().slice(0, 4)}`)
      : old.path;
    const branch = await withRepoLock(repo.path, async () => {
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
        // half a restore is a stray worktree git lists and toyon does not; the archive still has it
        await git(repo.path, "worktree", "remove", "--force", path);
        if (create) await git(repo.path, "branch", "-D", name);
        throw e;
      }
      return name;
    });
    const { variant: _variant, linkPath: _linkPath, ...rest } = old;
    const wt: WorktreeInfo = {
      ...rest,
      repoId: repo.id,
      path,
      branch,
      proxyPort: await allocateProxyPort(),
      // bringing it back is going back to work in it, so it sits with what you last sent to
      promptedAt: Date.now(),
      ...(createdBy ? { createdBy } : {}),
    };
    try {
      this.archive.take(old.id, this.chatFiles(old.id));
    } catch (e) {
      log.warn(old.id, "could not move its chat back out of the archive", e);
    }
    if (rec.sessionId && path === old.path) this.d.state.setSession(wt.id, rec.sessionId);
    const dropped = await git(repo.path, "update-ref", "-d", archiveRef(old.id));
    if (!dropped.ok) log.warn(old.id, `could not drop its archive ref: ${dropped.err}`);
    this.countsCache.delete(wt.id);
    this.refreshLink(wt);
    this.launch(wt, repo, repo.path);
    // setup and procs warm in the background; the agent takes the message now, as on create
    if (message) this.d.runtime.ensureAgent(wt).agent.send(message.text, { attachments: message.attachments });
    this.d.hub.emit("archiveChanged", repo.id);
    return wt;
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
    // the branch moves with the title, and only a toyon/ branch is toyon's to move: an adopted
    // worktree's branch is the person's
    if (!canRename(wt)) throw new UserError(`${wt.title} keeps its own branch; rename it in git`);
    const repo = this.d.state.requireRepo(wt.repoId);
    const clean = cleanTitle(title);
    if (!clean) return;
    await withRepoLock(repo.path, async () => {
      let branch = `toyon/${clean}`;
      if (branch !== wt.branch) {
        // avoid collisions with an existing branch
        let n = 2;
        while (!(await git(wt.path, "branch", "-m", wt.branch, branch)).ok) {
          if (n > 5) return;
          branch = `toyon/${clean}-${n++}`;
        }
        wt.branch = branch;
      }
      wt.title = clean;
    });
    this.refreshLink(wt);
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** `<repo>/<title>` → the directory, when its own name is not the title (a claimed spare keeps
   * wt-xxxx). The terminal and editor links show the link; git and procs keep the real path.
   * Moving the directory for real would restart the procs and the agent session (its cwd). */
  private refreshLink(wt: WorktreeInfo) {
    // Only toyon's own branches get a link. An adopted worktree sits in a directory the person
    // chose, and `desired` would put a symlink next to it under a name they never asked for
    // (adopting ~/Projects/app-editor-pane on branch `editor-pane` would create
    // ~/Projects/editor-pane, and again on every boot).
    if (!hasOwnBranch(wt)) return;
    // the branch tail rather than the title: titles may repeat (three tasks named alike), branches
    // never do (rename suffixes them)
    const name = wt.branch.replace(/^toyon\//, "");
    const desired = wt.kind === "worktree" ? join(dirname(wt.path), name) : wt.path;
    if (wt.linkPath && wt.linkPath !== desired) this.dropLink(wt);
    if (desired === wt.path) return;
    try {
      const st = lstatSync(desired, { throwIfNoEntry: false });
      // a real directory, or another worktree's link, keeps the name
      if (st && !(st.isSymbolicLink() && readlinkSync(desired) === wt.path)) return;
      if (!st) symlinkSync(wt.path, desired);
      wt.linkPath = desired;
    } catch (e) {
      log.warn(wt.id, "could not link the title to the directory", e);
    }
  }

  private dropLink(wt: WorktreeInfo) {
    const p = wt.linkPath;
    wt.linkPath = undefined;
    if (!p) return;
    try {
      if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(p);
    } catch (e) {
      log.warn(wt.id, "could not remove the title link", e);
    }
  }

  /** Declare a variant the winner: remove its siblings, drop its variant badge. */
  async pickVariant(worktreeId: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt?.variant) return;
    const group = wt.variant.group;
    const siblings = this.d.state.worktrees.filter((w) => w.variant?.group === group && w.id !== worktreeId);
    for (const sibling of siblings) {
      await this.archiveWorktree(sibling.id).catch((e) => log.warn(sibling.id, "could not archive variant sibling", e));
    }
    delete wt.variant;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
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
      const status = this.d.runtime.agentFor(w.id)?.status;
      if (status === "working" || status === "waiting")
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
    this.setLanded(target.id, false);
    this.countsCache.delete(target.id);
    this.d.hub.emit("worktreesChanged");
    return { target, grafted: sources.map((w) => w.title) };
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
    opts: { setupCommands?: boolean } = {},
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

  private async setupThenStart(
    wt: WorktreeInfo,
    repo: RepoInfo,
    depsSource: string,
    { setupCommands = true }: { setupCommands?: boolean },
  ): Promise<void> {
    // Copy-on-write where the fs allows it: `cp -c` (APFS clonefile), then GNU `--reflink=auto`
    // (btrfs/XFS), then a plain recursive copy (ext4). The log line records which
    // path ran and how long the fallback copy takes per worktree.
    const srcNm = join(depsSource, "node_modules");
    const dstNm = join(wt.path, "node_modules");
    if (existsSync(srcNm) && !existsSync(dstNm)) {
      const started = Date.now();
      const attempts: [string, string[]][] = [
        ["clonefile", ["-Rc", srcNm, dstNm]],
        ["reflink", ["-R", "--reflink=auto", srcNm, dstNm]],
        ["copy", ["-R", srcNm, dstNm]],
      ];
      for (const [how, args] of attempts) {
        if ((await run("cp", args, wt.path)).ok) {
          this.d.hub.emit("log", wt.id, "setup", `deps via ${how} in ${Date.now() - started}ms`);
          break;
        }
        await run("rm", ["-rf", dstNm], wt.path);
      }
    }
    for (const f of LOCAL_CONFIG_FILES) {
      const src = join(depsSource, f);
      if (!existsSync(src) || existsSync(join(wt.path, f))) continue;
      const r = await run("cp", [src, join(wt.path, f)], wt.path);
      if (r.ok) this.d.hub.emit("log", wt.id, "setup", `copied ${f}`);
      else log.warn(wt.id, `could not copy ${f}`, r.err);
    }
    // `bun install` and friends can take a minute: async, so every preview and agent stream keeps
    // flowing while a new worktree warms up
    for (const cmd of setupCommands ? (repo.config.setup ?? []) : []) {
      const code = await runSetup(
        cmd,
        wt.path,
        (line) => this.d.hub.emit("log", wt.id, "setup", line),
        worktreeEnv(wt, repo),
      );
      if (code !== 0) this.d.hub.emit("log", wt.id, "setup", `setup failed (exit ${code}): ${cmd}`);
    }
    await this.d.runtime.start(wt, repo);
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

  setLanded(worktreeId: string, landed: boolean) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.landed === landed || (landed && wt.kind === "main")) return;
    wt.landed = landed;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the landing verdict for a worktree, or none: written after a turn, retired by a new turn or
   * a tree that no longer matches it */
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
    const result = await commitWorktree(wt.path, this.commitMessage(wt, typed));
    if (result.ok) this.headMoved(wt.id);
    return result;
  }

  /** The one press. Commit what is uncommitted, take main in (a rebase for toyon's own branch),
   * then the repo's route: merge here, merge here and push main, or push the branch and open a
   * PR; on a worktree whose PR is already open, merge the PR. Each step stops the rest when it
   * fails, and the result says which: a commit stands even when the rebase after it conflicts,
   * since the work is safer committed. The worktree stays, marked landed once the work is on main
   * here, so the conversation can go on; closing it is its own press. Returns any variant
   * siblings to offer up. */
  async land(worktreeId: string, message?: string): Promise<{ result: ShipResult; archiveIds?: string[] }> {
    const { wt, repo } = this.landable(worktreeId, "land");
    const policy = landPolicy(repo.config);
    const own = hasOwnBranch(wt);
    const suggested = wt.landing?.subject
      ? wt.landing.body
        ? `${wt.landing.subject}\n\n${wt.landing.body}`
        : wt.landing.subject
      : undefined;

    if (policy.land === "pr") {
      // nothing here touches the main checkout, and gh holds the network for seconds: outside the lock
      if (wt.pr?.state === "open") {
        const result = await mergePr(wt.path, wt.pr.number, policy.merge);
        return { result };
      }
      const committed = await this.commitIfDirty(wt, message);
      if (committed && !committed.ok) return { result: committed };
      const taken = await takeMainIn(wt.path, repo.defaultBranch, own);
      if (!taken.ok) return { result: taken };
      this.headMoved(wt.id);
      const result = await openPr({
        worktreePath: wt.path,
        branch: wt.branch,
        defaultBr: repo.defaultBranch,
        subject: wt.landing?.subject,
        body: wt.landing?.body,
        automerge: policy.automerge,
        method: policy.merge,
      });
      if (result.ok) {
        this.setLanding(wt.id, undefined);
        if (result.pr) this.setPr(wt.id, { ...result.pr, at: Date.now() });
      }
      return { result };
    }

    let mergedHere = false;
    const result = await withRepoLock(repo.path, async (): Promise<ShipResult> => {
      const committed = await this.commitIfDirty(wt, message);
      if (committed && !committed.ok) return committed;
      // main here first takes what origin has, so the push at the end is not refused; a main
      // with no upstream has nothing to take
      if (policy.land === "push") {
        const pulled = await fastForwardMain(repo.path, repo.defaultBranch);
        if (!pulled.ok && !/no upstream/.test(pulled.message)) return pulled;
      }
      const taken = await takeMainIn(wt.path, repo.defaultBranch, own);
      if (!taken.ok) return taken;
      // read before the landing moves main and the branch restarts from it
      const mark = await landingMark(wt.path, repo.defaultBranch);
      const method = policy.merge ?? DEFAULT_MERGE_METHOD;
      const squash = method === "squash" ? await squashMessage(wt.path, repo.defaultBranch, suggested) : "";
      const landed = await landLocally(wt.path, wt.branch, repo.path, repo.defaultBranch, method, squash);
      if (!landed.ok) return landed;
      mergedHere = true;
      await this.noteLand(repo, wt, mark);
      await this.restartFromMain(wt, repo.defaultBranch);
      if (policy.land === "push") {
        const pushed = await pushMain(repo.path, repo.defaultBranch);
        if (!pushed.ok) return { ...pushed, message: `merged into ${repo.defaultBranch} here, but ${pushed.message}` };
      }
      return landed;
    });
    if (mergedHere) {
      // main moved, so every row of this repo counts against it now. The ref watcher clears this
      // too, but on the fs event's schedule, and the frame setLanded pushes must not carry the old
      // ahead. The verdict was about work that is on main now; the landed mark is what the box
      // reads next.
      this.invalidateCounts();
      this.setLanding(wt.id, undefined);
      this.setLanded(wt.id, true);
    }
    if (!result.ok) return { result };
    const archiveIds = wt.variant
      ? this.d.state.worktrees.filter((w) => w.variant?.group === wt.variant?.group && w.id !== wt.id).map((w) => w.id)
      : [];
    const where = policy.land === "push" ? `${repo.defaultBranch}, pushed` : repo.defaultBranch;
    return { result: { ...result, message: `${wt.title} is on ${where}` }, archiveIds };
  }

  /** A landing onto the record, oldest first, with its tip kept under a ref: the branch restarts from
   * main after it, and a squash never puts these commits on main, yet an archived worktree's page
   * still lists them. */
  private async noteLand(repo: RepoInfo, wt: WorktreeInfo, mark: LandingRange | null) {
    if (!mark) return;
    const n = wt.lands?.length ?? 0;
    const pinned = await git(repo.path, "update-ref", landRef(wt.id, n), mark.tip);
    if (!pinned.ok) {
      log.warn(wt.id, `could not keep the commits it landed: ${pinned.err}`);
      return;
    }
    wt.lands = [...(wt.lands ?? []), { ...mark, at: Date.now() }];
    this.d.state.save();
  }

  /** A branch toyon owns restarts from main once its work is there: the next message here builds
   * on main as it is, and the counts read zero rather than the commits a squash or a rebase on
   * GitHub left with different hashes. An adopted branch keeps its history. */
  private async restartFromMain(wt: WorktreeInfo, defaultBr: string) {
    if (!hasOwnBranch(wt)) return;
    const r = await git(wt.path, "reset", "--hard", defaultBr);
    if (!r.ok) log.warn(wt.id, `could not restart ${wt.branch} from ${defaultBr}: ${r.err}`);
    this.headMoved(wt.id);
  }

  /** GitHub merged the worktree's PR: main here takes it, the branch restarts from main, and the
   * row is landed. A main that cannot fast-forward (edits in its way, or commits of its own) is
   * left, and the box says so; main's own pull is the way through. */
  async prMerged(worktreeId: string): Promise<ShipResult> {
    const { wt, repo } = this.d.state.requireWorktreeWithRepo(worktreeId);
    const result = await withRepoLock(repo.path, async () => {
      const mark = await landingMark(wt.path, repo.defaultBranch);
      const pulled = await fastForwardMain(repo.path, repo.defaultBranch);
      if (!pulled.ok) return pulled;
      await this.noteLand(repo, wt, mark);
      await this.restartFromMain(wt, repo.defaultBranch);
      return pulled;
    });
    if (result.ok) {
      this.invalidateCounts();
      this.setLanding(wt.id, undefined);
      this.setLanded(wt.id, true);
    }
    return result;
  }

  /** take main into any row with a branch, a found worktree included: a rebase for toyon's own
   * branch, a merge for one it found or adopted. The one git write allowed without take-over,
   * because both refuse a dirty tree before touching it and abort on a conflict, so the directory
   * is left as it was found in every case but success. */
  async sync(worktreeId: string): Promise<{ result: ShipResult; defaultBranch: string }> {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("that worktree is gone");
    if (r.wt && isMain(r.wt)) throw new UserError("sync from a worktree, not main");
    if (!r.branch) throw new UserError(`${r.name} is detached: check out a branch in it first`);
    if (r.locked) throw new UserError(`${r.name} is held by another tool`);
    const repo = this.d.state.requireRepo(r.repoId);
    const own = r.wt ? hasOwnBranch(r.wt) : false;
    const result = await withRepoLock(repo.path, () => takeMainIn(r.path, repo.defaultBranch, own));
    if (result.ok) this.headMoved(worktreeId);
    return { result, defaultBranch: repo.defaultBranch };
  }

  /** fast-forward main to its upstream; every worktree's `behind` moves with it */
  async pull(worktreeId: string): Promise<ShipResult> {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (!isMain(wt)) throw new UserError("pull on main; a worktree syncs from main instead");
    const repo = this.d.state.requireRepo(wt.repoId);
    const result = await withRepoLock(repo.path, () => pullMain(repo.path, repo.defaultBranch));
    if (result.ok) {
      this.invalidateCounts();
      this.headMoved(worktreeId);
    }
    return result;
  }

  async commit(worktreeId: string, message: string): Promise<ShipResult> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const m = message.trim();
    if (!m) throw new UserError("commit message required");
    const result = await commitWorktree(wt.path, m);
    if (result.ok) this.headMoved(wt.id);
    return result;
  }

  /** stored, not cached: the first frame of a page load reads it before git has been asked */
  private setEmpty(wt: WorktreeInfo, empty: boolean) {
    if (wt.empty === empty) return;
    wt.empty = empty;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** this worktree's own HEAD moved (a sync or a commit): its cached ahead/behind describe the
   * old one, and nothing watches a worktree's branch the way the repo watcher watches main, so
   * the rail would keep the old badge until the TTL lapsed and something unrelated pushed a frame */
  /** main's `behind` is against its upstream, refreshed by a fetch every few minutes while
   * someone is looking: the count is only as good as the last fetch, and nobody runs one by hand
   * for a tool to read. No upstream, no count and no fetch. */
  private async mainCounts(path: string): Promise<{ behind?: number }> {
    const behind = await behindUpstream(path);
    if (behind === null) return {};
    const last = this.lastFetch.get(path) ?? 0;
    if (Date.now() - last > FETCH_EVERY_MS) {
      this.lastFetch.set(path, Date.now());
      fireAndForget(
        "fetch",
        run(GIT, ["fetch", "--quiet"], path, NO_PROMPT).then((r) => {
          if (!r.ok) {
            log.warn("fetch", `could not fetch ${path}: ${r.err.slice(0, 200)}`);
            return;
          }
          this.invalidateCounts();
          this.d.hub.emit("worktreesChanged");
        }),
      );
    }
    return { behind };
  }

  /** the figures for a row: what the stream said last, else what the transcript on disk ends with */
  private usageFor(worktreeId: string): WorktreeStatus["usage"] | undefined {
    const known = this.usage.get(worktreeId);
    if (known !== undefined) return known ?? undefined;
    const found = lastUsage(transcriptPathFor(this.d.paths.transcriptsDir, worktreeId));
    this.usage.set(worktreeId, found);
    return found ?? undefined;
  }

  private headMoved(worktreeId: string) {
    this.countsCache.delete(worktreeId);
    this.d.hub.emit("worktreesChanged");
  }

  // ---- queries ----

  /** badge counts are stale: every row's when the default branch moved, one worktree's when only
   * its own files did */
  invalidateCounts(worktreeId?: string) {
    if (worktreeId) this.countsCache.delete(worktreeId);
    else this.countsCache.clear();
  }

  /** Files may have changed where toyon could not see them (another app, while the window was
   * behind it): the same refresh as the default branch moving, every row recounted and every open
   * changes list re-read. */
  recount(repoId: string) {
    this.countsCache.clear();
    this.d.hub.emit("repoTick", repoId);
  }

  /** something under `.git/worktrees` changed: git's list is no longer what we last read */
  invalidateDiscovered() {
    this.discoverCache.clear();
  }

  /** A discovered row by id, from the last derivation only: no git, no await.
   *
   * The terminal opens inside one synchronous block on purpose (see the `term-open` handler), so
   * this cannot shell out. Reading the cache is honest here because the person can only click a
   * row that was pushed to them, and every push fills this cache: the watcher invalidates and then
   * emits, and the emit re-derives before the frame goes out. */
  discoveredById(id: string): FoundWorktree | null {
    for (const { rows } of this.discoverCache.values()) {
      const found = rows.find((r) => r.id === id);
      if (found) return found;
    }
    return null;
  }

  /** the last found rows per repo whatever their age; a repo never listed counts as a miss */
  private discoveredQuick(quick: { missed: boolean }): FoundWorktree[] {
    return this.d.state.repos.flatMap((repo) => {
      const cached = this.discoverCache.get(repo.id);
      if (cached) return cached.rows;
      quick.missed = true;
      return [];
    });
  }

  /** Worktrees git knows about that toyon does not, across every registered repo.
   *
   * Cached per repo on the same 10s floor as `counts()`: this runs on every `worktreesChanged`,
   * which fires on every proc event, and a dev-server log line should not shell out to git. The
   * watcher clears the cache when a worktree actually appears or goes, so the TTL bounds how often
   * we ask when nothing has happened, not how long a real change stays invisible. */
  async discovered(): Promise<FoundWorktree[]> {
    const perRepo = await Promise.all(
      this.d.state.repos.map(async (repo) => {
        const cached = this.discoverCache.get(repo.id);
        if (cached && Date.now() - cached.at < 10_000) return cached.rows;
        try {
          const rows = await discoverIn(repo.id, repo.path, this.d.state.worktrees);
          this.discoverCache.set(repo.id, { rows, at: Date.now() });
          return rows;
        } catch (e) {
          log.warn(repo.id, "could not list this repo's worktrees", e);
          return cached?.rows ?? [];
        }
      }),
    );
    const rows = perRepo.flat();
    // a shell at a directory that is no longer a discovered worktree has nothing to belong to: it
    // was taken over (its worktree runs a real shell now), removed, or its repo was forgotten
    this.d.runtime.pruneLooseShells(new Set(rows.map((r) => r.id)));
    return rows;
  }

  /** the badge numbers for one row. `baseline` is main, where HEAD is the default branch and
   * ahead/behind are zero by definition; a detached worktree has no branch to count either. */
  private async counts(
    id: string,
    path: string,
    defaultBranch: string,
    countable: boolean,
  ): Promise<{ ahead?: number; behind?: number; dirty?: number }> {
    const cached = this.countsCache.get(id);
    if (cached && Date.now() - cached.at < 10_000) return cached;
    try {
      const ab = countable ? await aheadBehind(path, defaultBranch) : await this.mainCounts(path);
      const fresh = { ...ab, dirty: (await statusFiles(path)).length, at: Date.now() };
      this.countsCache.set(id, fresh);
      return fresh;
    } catch {
      return cached ?? {};
    }
  }

  /** a worktree's dirty files and commits ahead of main, from git now rather than the rail's cached
   * counts: what an archive of its own accord is decided on. Empty when git cannot say. */
  async freshCounts(worktreeId: string): Promise<{ ahead?: number; dirty?: number }> {
    const wt = this.d.state.worktree(worktreeId);
    const repo = wt && this.d.state.repo(wt.repoId);
    if (!wt || !repo) return {};
    this.countsCache.delete(worktreeId);
    return this.counts(wt.id, wt.path, repo.defaultBranch, true);
  }

  /** Resolve an id for reading: a worktree toyon runs, or one it merely knows about. Null for a
   * spare (nobody looks at those) and for an id that is neither. */
  readable(id: string): ReadableWorktree | null {
    const wt = this.d.state.worktree(id);
    if (wt) {
      if (wt.kind === "spare") return null;
      const { defaultBranch } = this.d.state.requireRepo(wt.repoId);
      return { id, repoId: wt.repoId, path: wt.path, name: wt.title, branch: wt.branch, defaultBranch, wt };
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
    };
  }

  /** the working-tree state the changes panel shows (subscribe, edits, ref ticks). Also the one
   * place the `landed` badge is cleared: new work after a merge means it is no longer landed. */
  async gitStatus(worktreeId: string): Promise<GitInfo | null> {
    const r = this.readable(worktreeId);
    if (!r) return this.archivedStatus(worktreeId);
    try {
      // only main is its own baseline; every other worktree, discovered ones included, has a
      // branch worth counting against the default one
      const isMain = r.wt?.kind === "main";
      const [files, counts, head] = await Promise.all([
        statusFilesWithCounts(r.path),
        isMain ? Promise.resolve({}) : aheadBehind(r.path, r.defaultBranch),
        git(r.path, "rev-parse", "HEAD"),
      ]);
      const ahead = (counts as { ahead?: number }).ahead ?? 0;
      const committed = !isMain && ahead > 0 ? await committedFiles(r.path, r.defaultBranch) : undefined;
      if (r.wt?.landed && (files.length > 0 || ahead > 0)) {
        this.setLanded(r.wt.id, false);
        // new work after a merged PR is a new PR later; the old one is history
        if (r.wt.pr) this.setPr(r.wt.id, undefined);
      }
      // a verdict describes one tree: an edit since (by hand, by another tool) retires it, so the
      // composer never offers to land work the check and the message have not seen
      if (
        r.wt?.landing &&
        r.wt.landing.check !== "pending" &&
        r.wt.landing.fingerprint !== (await treeFingerprint(r.path))
      )
        this.setLanding(r.wt.id, undefined);
      // the empty-tree fact lives on main's record, so the rows frame carries it without git: a
      // task worktree of an empty repo is not the greenfield surface, so only main keeps it
      if (r.wt && isMain) this.setEmpty(r.wt, files.length === 0 ? await treeEmpty(r.path) : false);
      this.noteCounts(worktreeId, isMain, files.length, counts);
      return { files, committed, head: head.ok ? head.out : undefined, ...counts };
    } catch (e) {
      log.warn(worktreeId, "git status failed", e);
      return null;
    }
  }

  /** A status read is a fresher count than the rows' cache, so the row takes it: an agent's edits
   * reach the rail's badge with the changes list beside it, not at the end of the turn. A frame goes
   * out only when a number moved. Main's ahead and behind are counted against origin by the rows, so
   * it lends only its dirty count, and only once the rows have counted it the long way. */
  private noteCounts(id: string, main: boolean, dirty: number, ab: { ahead?: number; behind?: number }) {
    const prev = this.countsCache.get(id);
    if (main && !prev) return;
    const ahead = main ? prev?.ahead : ab.ahead;
    const behind = main ? prev?.behind : ab.behind;
    this.countsCache.set(id, { ahead, behind, dirty, at: Date.now() });
    if (prev?.dirty !== dirty || prev?.ahead !== ahead || prev?.behind !== behind) this.d.hub.emit("worktreesChanged");
  }

  /** the history tab's commit list. Unlike gitStatus this is asked for, not pushed: the panel
   * requests it when the tab is opened and after a commit, so a worktree nobody is reviewing
   * never pays for it. */
  async gitLog(worktreeId: string): Promise<CommitEntry[]> {
    const r = this.readable(worktreeId);
    if (r) return logCommits(r.path, r.defaultBranch);
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

  /** A message typed into a worktree's box. A worktree archived under it, a moment ago or
   * mid-send, comes back with the message as its first, the way one typed on its archived page
   * does; otherwise the agent gets it and the row is stamped as prompted. */
  async send(
    worktreeId: string,
    msg: { text: string; clientId?: string; context?: string[]; attachments?: AttachmentInput[] },
  ): Promise<void> {
    await this.archivingNow(worktreeId);
    if (!this.d.state.worktree(worktreeId) && this.hasArchived(worktreeId)) {
      await this.restore(worktreeId, msg.clientId, { text: msg.text, attachments: msg.attachments });
      return;
    }
    this.requireRun(worktreeId);
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    agent.send(msg.text, { context: msg.context, attachments: msg.attachments });
    // the stamp the rail sorts on; its frame also carries the queued count the send may have changed
    this.markPrompted(worktreeId);
  }

  /** someone sent something here, a chat message or a `!` command: the rail sorts on it */
  markPrompted(worktreeId: string) {
    const wt = this.d.state.worktree(worktreeId);
    // a discovered worktree has no record, and the rail keeps those in a section of their own
    if (!wt) return;
    wt.promptedAt = Date.now();
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** every row the rail shows: toyon's own worktrees in state order, then the ones git knows
   * about that toyon did not create. Both halves are awaited before either is returned, so a
   * frame never shows a taken-over worktree twice or not at all.
   *
   * `quick` answers from what is already known and never shells out: the counts and the found
   * rows come from their caches whatever their age, or are left off. It is the first frame of a
   * page load, which should paint the project before git has been asked about it; when anything
   * was missing the normal pass is queued behind it and its frame follows. */
  async rows(opts: { quick?: boolean } = {}): Promise<WorktreeStatus[]> {
    const quick = opts.quick ? { missed: false } : null;
    const [owned, found] = await Promise.all([this.ownedRows(quick), this.foundRows(quick)]);
    if (quick?.missed) setTimeout(() => this.d.hub.emit("worktreesChanged"), 0);
    return [...owned, ...found];
  }

  /** every repo's warm spare, for the draft tab's preview; never part of rows(). Ready once its
   * proxy is up (a boot-adopted spare has none until the repo's procs restart) and the pool still
   * counts it (an extra row adopt() is pruning does not). */
  spares(): SpareInfo[] {
    return this.d.state.worktrees
      .filter((wt) => wt.kind === "spare")
      .map((wt) => ({
        repoId: wt.repoId,
        id: wt.id,
        path: wt.path,
        proxyPort: wt.proxyPort,
        ready: this.d.runtime.get(wt.id)?.proxy != null && this.spare.current(wt.repoId)?.worktreeId === wt.id,
      }));
  }

  /** the cached counts for a row whatever their age, noting a miss for the quick pass */
  private countsQuick(id: string, quick: { missed: boolean }): { ahead?: number; behind?: number; dirty?: number } {
    const c = this.countsCache.get(id);
    if (c) return c;
    quick.missed = true;
    return {};
  }

  private async ownedRows(quick: { missed: boolean } | null): Promise<WorktreeStatus[]> {
    return Promise.all(
      this.d.state.worktrees
        .filter((wt) => wt.kind !== "spare")
        .map(async (wt) => {
          const rt = this.d.runtime.get(wt.id);
          const { defaultBranch } = this.d.state.requireRepo(wt.repoId);
          const { ahead, behind, dirty } = quick
            ? this.countsQuick(wt.id, quick)
            : await this.counts(wt.id, wt.path, defaultBranch, !isMain(wt));
          return {
            id: wt.id,
            repoId: wt.repoId,
            path: wt.path,
            name: wt.title,
            branch: wt.branch,
            worktree: wt,
            procs: rt?.procs?.states() ?? [],
            agent: rt?.agent.status ?? "idle",
            login: !!rt?.login,
            ahead,
            behind,
            dirty,
            queued: rt?.agent.queueLength || undefined,
            unseen: isUnseen(wt) || undefined,
            usage: this.usageFor(wt.id),
          };
        }),
    );
  }

  private async foundRows(quick: { missed: boolean } | null): Promise<WorktreeStatus[]> {
    const found = quick ? this.discoveredQuick(quick) : await this.discovered();
    return Promise.all(
      found.map(async (f) => {
        const repo = this.d.state.repo(f.repoId);
        const { ahead, behind, dirty } = !repo
          ? {}
          : quick
            ? this.countsQuick(f.id, quick)
            : await this.counts(f.id, f.path, repo.defaultBranch, !!f.branch);
        return { ...f, procs: [], agent: "idle" as const, login: false, ahead, behind, dirty };
      }),
    );
  }
}
