// Worktree lifecycle and landing: everything that decides what happens to a worktree. The
// transport layer (server/handlers.ts) calls in here and shapes replies; git/, runtime/ and the
// spare pool do the work.

import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitFileStatus, PickMeta, RepoInfo, WorktreeInfo, WorktreeStatus } from "@toyon/shared";
import { quickName } from "../agent/llm.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { git, gitOrThrow, run } from "../git/exec.ts";
import { commitWorktree, mergeToMain, type ShipResult, shipWorktree, syncFromMain } from "../git/land.ts";
import { withRepoLock } from "../git/lock.ts";
import { aheadBehind, committedFiles, statusFiles, statusFilesWithCounts } from "../git/status.ts";
import { allocateProxyPort, releasePort } from "../runtime/ports.ts";
import { resolveRun } from "../runtime/profile.ts";
import { DEFAULT_AGENT_ID, type RuntimeRegistry } from "../runtime/registry.ts";
import { cleanTitle, shortId, slugify, VARIANT_LENSES } from "./naming.ts";
import { SparePool } from "./spare.ts";

export type Variant = { group: string; index: number; of: number };

/** what `git status` + ahead/behind say about one worktree */
export interface GitInfo {
  files: GitFileStatus[];
  committed?: GitFileStatus[];
  ahead?: number;
  behind?: number;
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
}

export interface WorktreeServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  paths: Paths;
  agents: AgentRegistry;
  /** task → short kebab-case name (Haiku by default; tests inject a stub) */
  namer?: (prompt: string, cwd: string) => Promise<string | null>;
}

export class WorktreeService {
  readonly spare: SparePool;
  private countsCache = new Map<string, { ahead?: number; behind?: number; dirty: number; at: number }>();

  constructor(private d: WorktreeServiceDeps) {
    this.spare = new SparePool({
      state: d.state,
      hub: d.hub,
      runtime: d.runtime,
      paths: d.paths,
      setupAndStart: (wt, repo) => this.setupAndStart(wt, repo),
      remove: (id) => this.remove(id, true),
    });
    // worktrees claimed before links existed get theirs at boot
    for (const wt of d.state.worktrees) this.refreshLink(wt);
  }

  // ---- create / remove / rename ----

  async create(repoId: string, prompt: string, opts: CreateOpts = {}): Promise<WorktreeInfo> {
    const { variant, context, pick } = opts;
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
    let agentPrompt =
      variant && variant.of >= 2
        ? `${prompt}\n\n${VARIANT_LENSES[(variant.index - 1) % VARIANT_LENSES.length]}`
        : prompt;
    if (context) agentPrompt = `${agentPrompt}\n\n${context}`;

    // fast path: claim the pre-warmed spare (main-based tasks only). Its runtime — agent
    // included — already exists, so the task's first message goes to the spare's agent.
    if (fromMain) {
      const claimed = await this.spare.claim(repoId, branch, slug);
      if (claimed) {
        if (variant) claimed.variant = variant;
        if (opts.createdBy) claimed.createdBy = opts.createdBy;
        // the spare's agent has no process yet; it reads the stamp on its first prompt
        claimed.agent = agent;
        this.refreshLink(claimed);
        // the spare was warmed under the default profile; another one means its procs restart
        // (the agent stays, and gets the prompt now rather than after the restart)
        if (profile !== undefined && profile !== resolveRun(repo, claimed).profile) {
          claimed.profile = profile;
          this.restartProcs(claimed, repo);
        }
        this.d.state.save();
        this.d.hub.emit("worktreesChanged");
        this.d.runtime.ensureAgent(claimed).agent.send(agentPrompt, undefined, pick);
        this.scheduleNaming(claimed, prompt, repo, variant);
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
      agent,
      ...(variant ? { variant } : {}),
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      ...(profile !== undefined ? { profile } : {}),
    };
    this.d.state.addWorktree(wt);
    this.d.hub.emit("worktreesChanged");

    // setup + procs warm in the background; the agent starts immediately
    // RuntimeRegistry.start emits worktreesChanged once the procs are up
    fireAndForget(wt.id, this.setupAndStart(wt, repo, base?.path ?? repo.path), "setup + start");
    this.d.runtime.ensureAgent(wt).agent.send(agentPrompt, undefined, pick);
    this.scheduleNaming(wt, prompt, repo, variant);
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

  /** Async pretty-naming: solo worktrees rename directly; variant groups rename together
   * (index 1 runs the Haiku call, then every sibling becomes <name>-v<index>). */
  private scheduleNaming(wt: WorktreeInfo, prompt: string, repo: RepoInfo, variant?: Variant) {
    if (!variant) {
      fireAndForget(
        wt.id,
        (this.d.namer ?? quickName)(prompt, repo.path).then((name) => {
          if (name) return this.rename(wt.id, name);
        }),
        "auto-naming",
      );
      return;
    }
    if (variant.index !== 1) return; // sibling 1 names the whole group
    fireAndForget(
      wt.id,
      (this.d.namer ?? quickName)(prompt, repo.path).then(async (name) => {
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

  async remove(worktreeId: string, allowSpare = false): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "main" || (wt.kind === "spare" && !allowSpare)) return;
    const repo = this.d.state.requireRepo(wt.repoId);
    // the agent first (inside runtime.stop): it may be mid-turn in the directory about to be
    // deleted, and its session-info callback would re-add the session entry removed below
    await this.d.runtime.stop(worktreeId);
    await withRepoLock(repo.path, () => gitOrThrow(repo.path, "worktree", "remove", "--force", wt.path));
    this.dropLink(wt);
    this.d.state.removeWorktree(worktreeId);
    try {
      rmSync(transcriptPathFor(this.d.paths.transcriptsDir, worktreeId), { force: true });
    } catch (e) {
      log.warn(worktreeId, "could not delete transcript", e);
    }
    releasePort(wt.proxyPort);
    this.d.hub.emit("worktreesChanged");
  }

  async rename(worktreeId: string, title: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "main") return;
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
   * spare-xxxx). The terminal and editor links show the link; git and procs keep the real path.
   * Moving the directory for real would restart the procs and the agent session (its cwd). */
  private refreshLink(wt: WorktreeInfo) {
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

  /** Ephemeral local octopus merge of several worktree branches, as its own preview worktree. */
  async combine(worktreeIds: string[]): Promise<WorktreeInfo> {
    const wts = worktreeIds
      .map((id) => this.d.state.worktree(id))
      .filter((w): w is WorktreeInfo => !!w && w.kind !== "main");
    if (wts.length < 2) throw new UserError("select at least two worktrees to combine");
    const repoId = wts[0]!.repoId;
    if (!wts.every((w) => w.repoId === repoId)) throw new UserError("worktrees must belong to one repo");
    const repo = this.d.state.requireRepo(repoId);

    // graft names are the recipe: <a>+<b> (the ⧉ icon marks it as a graft); random suffix only on collision
    let slug = wts
      .map((w) => w.title.split("-")[0])
      .join("+")
      .slice(0, 40);
    if ((await git(repo.path, "show-ref", "--verify", `refs/heads/toyon/${slug}`)).ok) {
      slug = `${slug.slice(0, 34)}-${shortId().slice(0, 4)}`;
    }
    const branch = `toyon/${slug}`;
    const wtPath = join(this.d.paths.worktreesDir, repo.name, slug);

    await withRepoLock(repo.path, async () => {
      await gitOrThrow(repo.path, "worktree", "add", "-b", branch, wtPath, repo.defaultBranch);
      const m = await git(wtPath, "merge", "--no-edit", ...wts.map((w) => w.branch));
      if (!m.ok) {
        await git(wtPath, "merge", "--abort");
        await git(repo.path, "worktree", "remove", "--force", wtPath);
        await git(repo.path, "branch", "-D", branch);
        throw new UserError(`branches conflict — these worktrees can't be grafted cleanly (${m.err.slice(0, 200)})`);
      }
    });

    // a graft runs the sources' profile when they agree, else the default
    const profiles = new Set(wts.map((w) => w.profile));
    const profile = profiles.size === 1 ? wts[0]!.profile : undefined;
    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: wtPath,
      branch,
      kind: "combined",
      proxyPort: await allocateProxyPort(),
      title: slug,
      createdAt: Date.now(),
      sources: wts.map((w) => w.id),
      ...(profile !== undefined ? { profile } : {}),
    };
    this.d.state.addWorktree(wt);
    this.d.hub.emit("worktreesChanged");
    fireAndForget(wt.id, this.setupAndStart(wt, repo, wts[0]!.path), "setup + start");
    return wt;
  }

  // ---- setup ----

  /** Clone deps from the base checkout, run the repo's setup commands, then start the runtime. */
  async setupAndStart(wt: WorktreeInfo, repo: RepoInfo, depsSource = repo.path): Promise<void> {
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
    // `bun install` and friends can take a minute: async, so every preview and agent stream keeps
    // flowing while a new worktree warms up
    for (const cmd of repo.config.setup ?? []) {
      const r = await run("sh", ["-c", cmd], wt.path);
      if (!r.ok) this.d.hub.emit("log", wt.id, "setup", `setup failed: ${cmd}: ${r.err}`);
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
    if (pair.wt.kind === "main") throw new UserError(`${verb} from a worktree, not main`);
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
   * graft lands its sources; landing a variant ends the tournament. */
  async merge(worktreeId: string): Promise<{ result: ShipResult; removeIds?: string[] }> {
    const { wt, repo } = this.landable(worktreeId, "merge");
    // touches the main checkout: serialize with spare refresh / worktree add on the same repo
    const result = await withRepoLock(repo.path, () => mergeToMain(wt.path, wt.branch, repo.path, repo.defaultBranch));
    if (!result.ok) return { result };
    this.setLanded(wt.id, true);
    let removeIds: string[];
    if (wt.kind === "combined") {
      removeIds = [wt.id, ...(wt.sources ?? []).filter((id) => this.d.state.worktree(id))];
    } else if (wt.variant) {
      const group = wt.variant.group;
      removeIds = this.d.state.worktrees.filter((w) => w.variant?.group === group).map((w) => w.id);
    } else {
      removeIds = [wt.id];
    }
    return { result, removeIds };
  }

  async sync(worktreeId: string): Promise<{ result: ShipResult; defaultBranch: string }> {
    const { wt, repo } = this.landable(worktreeId, "sync");
    const result = await withRepoLock(repo.path, () => syncFromMain(wt.path, repo.defaultBranch));
    return { result, defaultBranch: repo.defaultBranch };
  }

  async commit(worktreeId: string, message: string): Promise<ShipResult> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const m = message.trim();
    if (!m) throw new UserError("commit message required");
    return commitWorktree(wt.path, m);
  }

  // ---- queries ----

  /** the default branch moved: badge counts are stale */
  invalidateCounts() {
    this.countsCache.clear();
  }

  private async counts(wt: WorktreeInfo): Promise<{ ahead?: number; behind?: number; dirty?: number }> {
    const cached = this.countsCache.get(wt.id);
    if (cached && Date.now() - cached.at < 10_000) return cached;
    try {
      const ab =
        wt.kind === "main" ? {} : await aheadBehind(wt.path, this.d.state.requireRepo(wt.repoId).defaultBranch);
      const fresh = { ...ab, dirty: (await statusFiles(wt.path)).length, at: Date.now() };
      this.countsCache.set(wt.id, fresh);
      return fresh;
    } catch {
      return cached ?? {};
    }
  }

  /** the working-tree state the changes panel shows (subscribe, edits, ref ticks). Also the one
   * place the `landed` badge is cleared: new work after a merge means it is no longer landed. */
  async gitStatus(worktreeId: string): Promise<GitInfo | null> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "spare") return null;
    try {
      const defaultBr = this.d.state.requireRepo(wt.repoId).defaultBranch;
      const [files, counts] = await Promise.all([
        statusFilesWithCounts(wt.path),
        wt.kind === "main" ? Promise.resolve({}) : aheadBehind(wt.path, defaultBr),
      ]);
      const ahead = (counts as { ahead?: number }).ahead ?? 0;
      const committed = wt.kind !== "main" && ahead > 0 ? await committedFiles(wt.path, defaultBr) : undefined;
      if (wt.landed && (files.length > 0 || ahead > 0)) this.setLanded(wt.id, false);
      return { files, committed, ...counts };
    } catch (e) {
      log.warn(worktreeId, "git status failed", e);
      return null;
    }
  }

  async statuses(): Promise<WorktreeStatus[]> {
    return Promise.all(
      this.d.state.worktrees
        .filter((wt) => wt.kind !== "spare")
        .map(async (wt) => {
          const rt = this.d.runtime.get(wt.id);
          const { ahead, behind, dirty } = await this.counts(wt);
          return {
            worktree: wt,
            procs: rt?.procs?.states() ?? [],
            agent: rt?.agent.status ?? "idle",
            ahead,
            behind,
            dirty,
            queued: rt?.agent.queueLength || undefined,
          };
        }),
    );
  }
}
