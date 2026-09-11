// Worktree lifecycle and landing: everything that decides what happens to a worktree. The
// transport layer (server/handlers.ts) calls in here and shapes replies; git/, runtime/ and the
// spare pool do the work.

import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type AgentEvent,
  type AgentStatus,
  type ArchivedWorktree,
  type CommitEntry,
  canGraft,
  canLand,
  canRemove,
  canRename,
  type GitFileStatus,
  hasOwnBranch,
  type ImageInput,
  isMain,
  type PasteInput,
  type PermissionMode,
  type PickMeta,
  type RefKind,
  type RepoInfo,
  type SpareInfo,
  type WorktreeInfo,
  type WorktreeStatus,
} from "@toyon/shared";
import type { OptionField } from "../agent/acp/options.ts";
import { attachmentsDirFor } from "../agent/attachments.ts";
import { canonical } from "../agent/bounds.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { makeNamer } from "../agent/tasks.ts";
import { cutPoint, transcriptPathFor } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { archiveRef, checkOutKept, commitOf, type KeptState, keepState } from "../git/archive.ts";
import { GIT, git, gitOrThrow, NO_PROMPT, run } from "../git/exec.ts";
import { commitWorktree, mergeToMain, pullMain, type ShipResult, shipWorktree, syncFromMain } from "../git/land.ts";
import { withRepoLock } from "../git/lock.ts";
import { logCommits, commitFiles as readCommitFiles } from "../git/log.ts";
import {
  aheadBehind,
  behindUpstream,
  committedFiles,
  statusFiles,
  statusFilesWithCounts,
  treeEmpty,
} from "../git/status.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { isInside } from "../repos/create.ts";
import { allocateProxyPort, releasePort } from "../runtime/ports.ts";
import { resolveRun } from "../runtime/profile.ts";
import { DEFAULT_AGENT_ID, type RuntimeRegistry } from "../runtime/registry.ts";
import { runSetup } from "../runtime/setup.ts";
import { type ArchiveRecord, type ChatFiles, firstPrompt, summarize, WorktreeArchive } from "./archive.ts";
import { discoverIn, type FoundWorktree } from "./discover.ts";
import { cleanTitle, shortId, slugify, VARIANT_LENSES } from "./naming.ts";
import { SparePool } from "./spare.ts";

/** Gitignored local config a worktree needs and git will never bring over. Absent secrets fail
 * deep inside app code rather than as missing config (an empty AUTH_SECRET reads as a zero-length
 * HMAC key), so copy whatever the base checkout actually has. */
const LOCAL_CONFIG_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars"];

export type Variant = { group: string; index: number; of: number };

/** what a grafted transcript keeps of a message: the source's attachment store goes with the
 * source, so an image or paste ref would point at nothing; the captions in the text stay */
function withoutAttachments(event: AgentEvent): AgentEvent {
  if (event.type !== "user-message") return event;
  const { images: _images, pastes: _pastes, ...rest } = event;
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

export interface CreateOpts {
  /** the shell tab that asked; stored as createdBy so only that tab auto-focuses the result */
  createdBy?: string;
  /** registry id; the daemon's default when absent */
  agent?: string;
  baseWorktreeId?: string;
  variant?: Variant;
  context?: string;
  pick?: PickMeta;
  /** one of the repo's profiles; the repo's default when absent */
  profile?: string;
  /** what the agent may do without asking; the default mode when absent */
  mode?: PermissionMode;
  /** one of the agent's advertised model ids; its default when absent */
  model?: string;
  /** one of the agent's advertised effort levels; its default when absent */
  effort?: string;
  images?: ImageInput[];
  pastes?: PasteInput[];
}

export interface WorktreeServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  paths: Paths;
  agents: AgentRegistry;
  /** task → short kebab-case name (the worktree's own agent by default; tests inject a stub) */
  namer?: (prompt: string, wt: WorktreeInfo) => Promise<string | null>;
}

/** how often main's upstream is fetched while its row is being counted */
const FETCH_EVERY_MS = 5 * 60_000;

export class WorktreeService {
  readonly spare: SparePool;
  private archive: WorktreeArchive;
  private countsCache = new Map<string, { ahead?: number; behind?: number; dirty: number; at: number }>();
  /** per repo, because discovery asks git once for the whole repo rather than once per worktree */
  private discoverCache = new Map<string, { rows: FoundWorktree[]; at: number }>();
  /** the agent status each worktree last reported, so a turn's end is an edge and not a level */
  private lastAgentStatus = new Map<string, AgentStatus>();
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
      remove: async (id) => {
        await this.remove(id, { spare: true });
      },
    });
    // worktrees claimed before links existed get theirs at boot
    for (const wt of d.state.worktrees) this.refreshLink(wt);
    // The rail rings a worktree whose turn ended while nobody was looking, so the edge into idle
    // is the moment worth recording. Only a busy → idle edge counts: a session reports idle at
    // birth too, and stamping that would ring every worktree the daemon has ever started.
    // Subscribed here rather than in the ws layer because this listener has to run before the one
    // that broadcasts statuses, and services are constructed before the server.
    d.hub.on("agent", (worktreeId, _seq, event) => {
      if (event.type !== "usage") return;
      const { used, size, cost } = event;
      this.usage.set(worktreeId, { used, size, ...(cost !== undefined ? { cost } : {}) });
    });
    d.hub.on("agentStatus", (worktreeId, status) => {
      const prev = this.lastAgentStatus.get(worktreeId) ?? "idle";
      this.lastAgentStatus.set(worktreeId, status);
      if (status !== "idle" || (prev !== "working" && prev !== "waiting")) return;
      const wt = d.state.worktree(worktreeId);
      // gone already if the worktree was removed mid-turn; nothing to stamp
      if (!wt) return;
      wt.lastTurnAt = Date.now();
      d.state.save();
      // A proc that crashed or never answered gets another go once the agent has had a turn: the
      // boot pane's "ask the agent to fix it" ends here, and a fix nobody restarts after is not a
      // fix. A proc that is fine, or one you stopped yourself, is left alone.
      for (const p of d.runtime.get(worktreeId)?.procs?.states() ?? []) {
        if (p.status !== "crashed" && p.status !== "unreachable") continue;
        d.hub.emit("log", worktreeId, p.name, "restarting after the agent's turn");
        fireAndForget(worktreeId, d.runtime.restartStream(worktreeId, p.name), "restart after turn");
      }
    });
  }

  // ---- create / remove / rename ----

  async create(repoId: string, prompt: string, opts: CreateOpts = {}): Promise<WorktreeInfo> {
    const { variant, context, pick, images, pastes } = opts;
    const repo = this.d.state.requireRepo(repoId);
    // validated up front: an unknown or uninstalled agent is a toast now, not a dead worktree later
    const agent = this.d.agents.require(opts.agent ?? this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id;
    const profile = this.checkProfile(repo, opts.profile);
    // variants share a name base so they read as siblings in the list
    let slug = variant ? `${slugify(prompt, false)}-v${variant.index}` : slugify(prompt);
    if (variant && (await git(repo.path, "show-ref", "--verify", `refs/heads/toyon/${slug}`)).ok) {
      slug = `${slug}-${shortId().slice(0, 3)}`;
    }
    const branch = `toyon/${slug}`;

    // fork point: main's branch by default, or the base worktree's branch (stacking)
    const base = opts.baseWorktreeId ? this.d.state.worktree(opts.baseWorktreeId) : undefined;
    const fromMain = !base || base.kind === "main";

    // perspective-diverse variants: same goal, different emphasis per attempt
    const agentPrompt =
      variant && variant.of >= 2
        ? `${prompt}\n\n${VARIANT_LENSES[(variant.index - 1) % VARIANT_LENSES.length]}`
        : prompt;

    // fast path: claim the pre-warmed spare (main-based tasks only). Its runtime — agent
    // included — already exists, so the task's first message goes to the spare's agent.
    if (fromMain) {
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
        this.d.state.save();
        this.d.hub.emit("worktreesChanged");
        this.d.runtime.ensureAgent(claimed).agent.send(agentPrompt, { context, pick, images, pastes });
        this.scheduleNaming(claimed, prompt, variant);
        return claimed;
      }
    }

    const wtPath = join(this.d.paths.worktreesDir, repo.name, slug);
    const baseBranch = fromMain ? repo.defaultBranch : base!.branch;
    await withRepoLock(repo.path, () => gitOrThrow(repo.path, "worktree", "add", "-b", branch, wtPath, baseBranch));

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
    // setup + procs warm in the background; the agent starts immediately
    this.launch(wt, repo, base?.path ?? repo.path);
    this.d.runtime.ensureAgent(wt).agent.send(agentPrompt, { context, pick, images, pastes });
    this.scheduleNaming(wt, prompt, variant);
    return wt;
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

  /** The discovered row at this path as it stands right now, or a toast.
   *
   * Re-derived rather than read from the cache because the frame the person clicked can be
   * seconds old, and a lock is the only thing standing between us and another agent's working
   * directory: it must still be on the list the daemon would push. */
  private async requireDiscovered(repoId: string, repoPath: string, target: string): Promise<FoundWorktree> {
    const rows = await discoverIn(repoId, repoPath, this.d.state.worktrees);
    const found = rows.find((r) => canonical(r.path) === target);
    if (!found) throw new UserError("that worktree is gone, or toyon already has it");
    return found;
  }

  /** Promote a worktree git knows about into one toyon runs.
   *
   * The directory already exists and someone else made it, so this allocates a port, records it and
   * starts the procs. It deliberately does not run `toyon.json`'s setup commands (see
   * `setupAndStart`) and does not start an agent: take-over is not a task, and the agent comes up
   * on the first message like it does anywhere else. */
  async adopt(worktreeId: string, createdBy?: string): Promise<WorktreeInfo> {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("that worktree is gone");
    if (r.wt) throw new UserError(`toyon already runs ${r.name}`);
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
      if (enclosing) throw new UserError(`${found.name} sits inside ${enclosing.path}, which toyon already manages`);
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

  /** a profile name the repo actually has, or undefined for "the default"; a typo is a toast */
  private checkProfile(repo: RepoInfo, name: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    if (!repo.config.profiles?.[name]) throw new UserError(`no profile "${name}" in ${repo.name}'s toyon.json`);
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

  /** Remove a worktree: its runtime, its directory, its branch when the branch is toyon's, and its
   * record. The chat is archived rather than deleted, with the commits and uncommitted work kept
   * under a ref, so a remove can be undone and a landed branch's conversation brought back. A spare
   * holds nobody's work and a grafted source's history already lives in its target, so those two
   * go outright. Returns what was archived, if anything. */
  async remove(
    worktreeId: string,
    opts: { spare?: boolean; archive?: boolean } = {},
  ): Promise<ArchivedWorktree | null> {
    const wt = this.d.state.worktree(worktreeId);
    // a spare is the pool's to remove, never a person's
    if (!wt || !(canRemove(wt) || (opts.spare && wt.kind === "spare"))) return null;
    const repo = this.d.state.requireRepo(wt.repoId);
    const archive = wt.kind !== "spare" && opts.archive !== false;
    // the agent first (inside runtime.stop): it may be mid-turn in the directory about to be
    // deleted, and its session-info callback would re-add the session entry removed below
    await this.d.runtime.stop(worktreeId);
    const kept = await withRepoLock(repo.path, async () => {
      // before the directory goes: its uncommitted work exists nowhere else
      const k = archive ? await this.keep(repo, wt) : null;
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
    if (archive) archived = this.archiveChat(wt, repo, kept, sessionId);
    else this.deleteChat(worktreeId);
    this.d.hub.emit("worktreesChanged");
    return archived;
  }

  /** a worktree's commits and uncommitted work, under its archive ref, before its directory goes */
  private async keep(repo: RepoInfo, wt: WorktreeInfo): Promise<KeptState | null> {
    const index = join(this.d.paths.archiveDir, `${wt.id}.index`);
    const kept = await keepState(repo.path, wt.path, archiveRef(wt.id), index);
    if (!kept) log.warn(wt.id, "could not keep its git state: the chat is archived without its work");
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
  ): ArchivedWorktree | null {
    const files = this.chatFiles(wt.id);
    const prompt = firstPrompt(files.transcript);
    const rec: ArchiveRecord = {
      worktree: wt,
      repoPath: repo.path,
      archivedAt: Date.now(),
      ...(sessionId ? { sessionId } : {}),
      ...(prompt ? { prompt } : {}),
      ...(kept ? { kept } : {}),
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

  /** a project's archived worktrees, newest first */
  archived(repoId: string): ArchivedWorktree[] {
    const repo = this.d.state.repo(repoId);
    return repo ? this.archive.list(repo) : [];
  }

  /** the project a record belongs to now: by id, or by checkout when it was forgotten and reopened */
  private repoOf(rec: ArchiveRecord): RepoInfo | undefined {
    return this.d.state.repo(rec.worktree.repoId) ?? this.d.state.repos.find((r) => r.path === rec.repoPath);
  }

  /** Put an archived worktree back as it was removed: its branch at the commit it was on, its
   * uncommitted work over that, unstaged, and its chat. The agent resumes its own session when the
   * directory is the same one, since that is what the session is keyed by. */
  async restore(archiveId: string, createdBy?: string): Promise<WorktreeInfo> {
    const rec = this.archive.get(archiveId);
    if (!rec) throw new UserError("that archived worktree is gone");
    const old = rec.worktree;
    const repo = this.repoOf(rec);
    if (!repo) throw new UserError(`${old.title} belongs to a project that is not open`);
    const kept = rec.kept;
    if (!kept) throw new UserError(`${old.title} was archived without its commits, so there is nothing to restore`);
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
    this.archive.delete(archiveId);
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
      await this.remove(sibling.id).catch((e) => log.warn(sibling.id, "could not remove variant sibling", e));
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
      for (const { event } of entries.slice(cutPoint(entries))) agent.note(withoutAttachments(event));
    }
    for (const w of sources) await this.remove(w.id, { archive: false });
    this.setLanded(target.id, false);
    this.countsCache.delete(target.id);
    this.d.hub.emit("worktreesChanged");
    return { target, grafted: sources.map((w) => w.title) };
  }

  // ---- setup ----

  /** Clone deps from the base checkout, run the repo's setup commands, then start the runtime.
   *
   * `setupCommands: false` keeps the two copies (both no-ops when the destination already has the
   * files) and skips `toyon.json`'s `setup` list, which has no such guard. Adoption uses it: those
   * commands are `bun install`, migrations, `docker compose up`, and a directory someone has been
   * working in is the last place to re-run them behind their back. */
  async setupAndStart(
    wt: WorktreeInfo,
    repo: RepoInfo,
    depsSource = repo.path,
    { setupCommands = true }: { setupCommands?: boolean } = {},
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
      const code = await runSetup(cmd, wt.path, (line) => this.d.hub.emit("log", wt.id, "setup", line), {
        TOYON_WORKTREE: wt.id,
      });
      if (code !== 0) this.d.hub.emit("log", wt.id, "setup", `setup failed (exit ${code}): ${cmd}`);
    }
    await this.d.runtime.start(wt, repo);
  }

  // ---- landing ----

  setPrUrl(worktreeId: string, url: string) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    wt.prUrl = url;
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

  private landable(worktreeId: string, verb: string): { wt: WorktreeInfo; repo: RepoInfo } {
    const pair = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (isMain(pair.wt)) throw new UserError(`${verb} from a worktree, not main`);
    if (!canLand(pair.wt)) throw new UserError(`${pair.wt.title} is a PR under review; it lands upstream, not here`);
    return pair;
  }

  /** push + PR. Not under the repo lock: it holds `git push` + `gh` for seconds. */
  async ship(worktreeId: string): Promise<ShipResult> {
    const { wt, repo } = this.landable(worktreeId, "ship");
    const result = await shipWorktree(wt.path, wt.branch, repo.defaultBranch);
    if (result.prCreated && result.url) this.setPrUrl(wt.id, result.url);
    return result;
  }

  /** merge into main locally. Returns the worktrees the UI should offer to clean up: landing a
   * variant ends the tournament. */
  async merge(worktreeId: string): Promise<{ result: ShipResult; removeIds?: string[] }> {
    const { wt, repo } = this.landable(worktreeId, "merge");
    // touches the main checkout: serialize with spare refresh / worktree add on the same repo
    const result = await withRepoLock(repo.path, () => mergeToMain(wt.path, wt.branch, repo.path, repo.defaultBranch));
    if (!result.ok) return { result };
    // main moved, so every row of this repo counts against it now. The ref watcher clears this
    // too, but on the fs event's schedule, and the frame setLanded pushes must not carry the old
    // ahead
    this.invalidateCounts();
    this.setLanded(wt.id, true);
    let removeIds: string[];
    if (wt.variant) {
      const group = wt.variant.group;
      removeIds = this.d.state.worktrees.filter((w) => w.variant?.group === group).map((w) => w.id);
    } else {
      removeIds = [wt.id];
    }
    return { result, removeIds };
  }

  /** merge main into any row with a branch, a found worktree included: the one git write allowed
   * without take-over, because syncFromMain refuses a dirty tree before touching it and aborts a
   * conflicted merge, so the directory is left as it was found in every case but success */
  async sync(worktreeId: string): Promise<{ result: ShipResult; defaultBranch: string }> {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("that worktree is gone");
    if (r.wt && isMain(r.wt)) throw new UserError("sync from a worktree, not main");
    if (!r.branch) throw new UserError(`${r.name} is detached: check out a branch in it first`);
    if (r.locked) throw new UserError(`${r.name} is held by another tool`);
    const repo = this.d.state.requireRepo(r.repoId);
    const result = await withRepoLock(repo.path, () => syncFromMain(r.path, repo.defaultBranch));
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
    let found: WorktreeStatus["usage"] | null = null;
    const file = transcriptPathFor(this.d.paths.transcriptsDir, worktreeId);
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0 && !found; i--) {
        if (!lines[i]?.includes('"usage"')) continue;
        try {
          const e = JSON.parse(lines[i]!).event;
          if (e?.type === "usage")
            found = { used: e.used, size: e.size, ...(e.cost !== undefined ? { cost: e.cost } : {}) };
        } catch {
          // a torn line at the end of a transcript is the loader's problem, not this read's
        }
      }
    }
    this.usage.set(worktreeId, found);
    return found ?? undefined;
  }

  private headMoved(worktreeId: string) {
    this.countsCache.delete(worktreeId);
    this.d.hub.emit("worktreesChanged");
  }

  // ---- queries ----

  /** the default branch moved: badge counts are stale */
  invalidateCounts() {
    this.countsCache.clear();
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
    if (!r) return null;
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
      if (r.wt?.landed && (files.length > 0 || ahead > 0)) this.setLanded(r.wt.id, false);
      // the empty-tree fact lives on main's record, so the rows frame carries it without git: a
      // task worktree of an empty repo is not the greenfield surface, so only main keeps it
      if (r.wt && isMain) this.setEmpty(r.wt, files.length === 0 ? await treeEmpty(r.path) : false);
      return { files, committed, head: head.ok ? head.out : undefined, ...counts };
    } catch (e) {
      log.warn(worktreeId, "git status failed", e);
      return null;
    }
  }

  /** the history tab's commit list. Unlike gitStatus this is asked for, not pushed: the panel
   * requests it when the tab is opened and after a commit, so a worktree nobody is reviewing
   * never pays for it. */
  async gitLog(worktreeId: string): Promise<CommitEntry[]> {
    const r = this.readable(worktreeId);
    return r ? logCommits(r.path, r.defaultBranch) : [];
  }

  /** the files one commit touched, on expanding it in the history tab */
  async commitFiles(worktreeId: string, sha: string): Promise<GitFileStatus[]> {
    const r = this.readable(worktreeId);
    return r ? readCommitFiles(r.path, sha) : [];
  }

  /** someone is looking at this worktree right now: clear its unseen ring */
  markSeen(worktreeId: string) {
    const wt = this.d.state.worktree(worktreeId);
    // a discovered worktree has no turns, so nothing to have missed
    if (!wt) return;
    if (wt.seenAt != null && wt.lastTurnAt != null && wt.seenAt >= wt.lastTurnAt) return;
    wt.seenAt = Date.now();
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
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
        return { ...f, procs: [], agent: "idle" as const, ahead, behind, dirty };
      }),
    );
  }
}

/** a turn finished here since anyone last looked. A worktree with no `lastTurnAt` reads as seen,
 * so worktrees that predate the field do not all light up the first time the daemon restarts. */
function isUnseen(wt: WorktreeInfo): boolean {
  return wt.lastTurnAt != null && (wt.seenAt == null || wt.seenAt < wt.lastTurnAt);
}
