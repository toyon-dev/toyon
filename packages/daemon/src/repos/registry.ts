// Repos: registration, config confirmation, default-branch watchers, and boot (bring every
// persisted repo and worktree back up).

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PendingRepo, RepoInfo, ToyonConfig, WorktreeInfo } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { defaultBranch, git, isGitRepo, repoRoot } from "../git/exec.ts";
import { statusFiles, treeEmpty } from "../git/status.ts";
import { allocateProxyPort, releasePort, reservePort } from "../runtime/ports.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { shortId } from "../worktrees/naming.ts";
import type { WorktreeService } from "../worktrees/service.ts";
import { expandTilde } from "./browse.ts";
import { detectConfig, readConfigFile } from "./config.ts";
import {
  type CreateOpts,
  cloneInto,
  createRepoDir,
  type GitIdentity,
  hasGitIdentity,
  initRepoInPlace,
  isInside,
  type Plan,
  planInPlace,
  planProject,
  setGitIdentity,
  unmakeProject,
} from "./create.ts";
import { watchConfigFile, watchDefaultBranch, watchWorktreeDir } from "./watcher.ts";

/** whether `pr` has anywhere to push: read once at register and boot, since remotes rarely change */
const hasOrigin = async (path: string) => (await git(path, "remote", "get-url", "origin")).ok;

export interface RepoRegistryDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  worktrees: WorktreeService;
}

/** git's progress redraws many times a second; the pane only has to look alive */
const IMPORT_TICK_MS = 250;
/** enough scrollback to see what git is doing, not a transcript */
const IMPORT_LINES = 40;

export class RepoRegistry {
  private watchers = new Map<string, () => void>();
  private imports = new Map<string, { pending: PendingRepo; abort: AbortController }>();
  /** repos whose worktrees have been started this daemon run; the rest are cold */
  private warmed = new Set<string>();
  /** whether git can commit without asking, for hello. Kept, since hello goes out on every page
   * load; a create reads it again, being the one thing in here that changes it. */
  private identity: Promise<boolean> | null = null;

  constructor(private d: RepoRegistryDeps) {
    // A scaffold lands during a turn, and the repo it landed in was registered while empty, so
    // the guess it carries is stale. turn-end is already an edge, and it fires before the status
    // flips to idle, so the fresh guess reaches the shell before the frame that ends the busy state.
    d.hub.on("agent", (worktreeId, _seq, event) => {
      if (event.type === "turn-end") this.redetect(worktreeId);
    });
  }

  /** Recover the persisted state, reserve every port, and watch every repo. Nothing runs yet: a
   * daemon that starts a dev server for every worktree of every registered repo the moment it
   * comes up is fifteen vite processes on a laptop whose owner wanted one, so a repo's worktrees
   * start together the first time something touches the repo (`warm`), and a single worktree
   * starts on its own when it is opened after that (`touch`). */
  async boot(): Promise<void> {
    const { state } = this.d;
    // a worktree whose directory or project went while the daemon was down leaves the way a remove
    // would have taken it, rather than leaving its transcript behind with nothing pointing at it
    const gone = state.worktrees.filter((wt) => !existsSync(wt.path) || !state.repos.some((r) => r.id === wt.repoId));
    for (const wt of gone) await this.d.worktrees.forgetGone(wt);
    // toyon.json may have been edited while the daemon was down, and so may the remotes
    for (const repo of state.repos) {
      this.applyConfigFile(repo, false);
      repo.remote = await hasOrigin(repo.path);
    }
    for (const wt of state.worktrees) reservePort(wt.proxyPort);
    state.save();
    for (const repo of state.repos) {
      this.startWatcher(repo);
      this.d.worktrees.spare.adopt(repo.id);
    }
    const cold = state.worktrees.filter((w) => w.kind !== "spare").length;
    if (cold > 0) log.info("daemon", `${cold} worktrees across ${state.repos.length} repos start when opened`);
  }

  /** Start every worktree of a repo, once per daemon run. Sequential and in the background: the
   * caller is a subscribe or a register that should answer now, and one dev server at a time is
   * how boot always started them. */
  warm(repoId: string): void {
    if (this.warmed.has(repoId)) return;
    this.warmed.add(repoId);
    const repo = this.d.state.requireRepo(repoId);
    const mine = this.d.state.worktrees.filter((w) => w.repoId === repoId && w.kind !== "spare");
    fireAndForget(
      repoId,
      (async () => {
        for (const wt of mine) await this.d.runtime.start(wt, repo);
      })(),
      "warm",
    );
    this.d.worktrees.spare.warm(repoId);
  }

  /** a worktree is being looked at: its repo warms if it has not, and it starts if it is cold */
  touch(worktreeId: string): void {
    const { wt, repo } = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (!this.warmed.has(repo.id)) {
      this.warm(repo.id);
      return;
    }
    if (!this.d.runtime.get(wt.id)?.procs) fireAndForget(wt.id, this.d.runtime.start(wt, repo), "start on open");
  }

  /** Make a project and open it. The containment check lives here rather than in `create.ts`
   * because it is the only part that needs daemon state: see `refuseIfManaged`. */
  async create(opts: CreateOpts & { identity?: GitIdentity }): Promise<RepoInfo> {
    const inPlace = opts.mode === "init";
    const { dir } = inPlace ? planInPlace(opts) : planProject(opts);
    this.refuseIfManaged(dir);
    try {
      // after the plan, so a refused name or place writes nothing to the person's git config
      if (opts.identity) await setGitIdentity(opts.identity);
      const path = await (inPlace ? initRepoInPlace(opts) : createRepoDir(opts));
      return await this.register(path, inPlace ? "git" : "folder");
    } finally {
      this.identity = null;
    }
  }

  gitIdentity(): Promise<boolean> {
    this.identity ??= hasGitIdentity(homedir());
    return this.identity;
  }

  /** Take back a project made here, for the way back from its first-run screen to the new-project
   * page. Only one still exactly as it was made: every sign of use is read again from disk and git
   * rather than trusted from a record, since what a wrong answer here deletes is the person's work. */
  async unmake(repoId: string): Promise<void> {
    const repo = this.d.state.requireRepo(repoId);
    const { made } = repo;
    if (!made) throw new UserError(`${repo.name} was opened, not made here, so toyon will not remove it`);
    const used = await this.usedSign(repo);
    if (used) throw new UserError(`${used}, so it can't be renamed or moved from here`);
    await this.forget(repoId);
    await unmakeProject(repo.path, made);
  }

  /** the first sign that a project has been used since it was made, as the words that say so */
  private async usedSign(repo: RepoInfo): Promise<string | null> {
    const mine = this.d.state.worktrees.filter((w) => w.repoId === repo.id);
    const main = mine.find((w) => w.kind === "main");
    if (!main || mine.length > 1) return `${repo.name} has worktrees now`;
    if (!repo.needsSetup) return `${repo.name} is set up now`;
    if (main.promptedAt || main.lastTurn) return `${repo.name} has a chat now`;
    // an adapter writes its settings here on its first spawn, which is excluded from git's view
    if (existsSync(join(repo.path, ".claude"))) return `an agent has already run in ${repo.name}`;
    if ((await statusFiles(repo.path)).length > 0 || !(await treeEmpty(repo.path))) {
      return `${repo.name} has files in it now`;
    }
    if ((await git(repo.path, "rev-list", "--count", "HEAD")).out !== "1") return `${repo.name} has commits now`;
    return null;
  }

  /** A project nested inside a repo or worktree toyon already manages is the thing to prevent, and
   * only these records can answer that. A blanket `isGitRepo(parent)` would be wrong: a home
   * directory that is itself a dotfiles repo is an ordinary setup, and making a project under it
   * is fine. */
  private refuseIfManaged(dir: string): void {
    const managed = [...this.d.state.repos, ...this.d.state.worktrees].some((r) => isInside(dir, r.path));
    if (managed) throw new UserError(`${dir} is inside a project toyon already manages`);
  }

  /** clones in flight, oldest first */
  get pending(): PendingRepo[] {
    return [...this.imports.values()].map((i) => i.pending).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Start a clone and hand back the record for it. Unlike every other way a project arrives, this
   * one takes long enough that the person needs to see it happening, so it becomes a thing the
   * daemon holds rather than a promise the calling socket waits on: every tab sees it, a reload
   * does not lose it, and it can be stopped.
   */
  startImport(opts: { parent: string; name: string; url: string }): PendingRepo {
    // validated before anything is announced, so a bad name or a typo'd parent is still a plain
    // error on the socket that asked rather than a pending row that fails a moment later
    const plan = planProject(opts);
    this.refuseIfManaged(plan.dir);
    if (this.pending.some((p) => p.name === opts.name && p.parent === plan.parent)) {
      throw new UserError(`${opts.name} is already being cloned`);
    }
    const pending: PendingRepo = {
      id: shortId(),
      name: opts.name.trim(),
      parent: plan.parent,
      url: opts.url,
      startedAt: Date.now(),
      lines: [],
    };
    const abort = new AbortController();
    this.imports.set(pending.id, { pending, abort });
    this.d.hub.emit("pendingChanged");
    fireAndForget(pending.id, this.runImport(pending, plan, abort.signal), "clone");
    return pending;
  }

  /** stop a clone that is still running, or dismiss one that failed */
  cancelImport(id: string): void {
    const entry = this.imports.get(id);
    if (!entry) throw new UserError("that import is already finished");
    entry.abort.abort(); // kills git; cloneInto then removes the half-made directory
    this.imports.delete(id);
    this.d.hub.emit("pendingChanged");
  }

  private async runImport(pending: PendingRepo, plan: Plan, signal: AbortSignal): Promise<void> {
    let last = 0;
    const tick = (force: boolean) => {
      if (!force && Date.now() - last < IMPORT_TICK_MS) return;
      last = Date.now();
      this.d.hub.emit("pendingChanged");
    };
    try {
      await cloneInto(plan, pending.name, pending.url, {
        signal,
        onLine: (line) => {
          pending.lines.push(line);
          if (pending.lines.length > IMPORT_LINES) pending.lines.shift();
          tick(false);
        },
      });
      if (signal.aborted) return; // cancelImport already dropped it and cloneInto cleaned up
      this.imports.delete(pending.id);
      this.d.hub.emit("pendingChanged");
      await this.register(plan.dir);
    } catch (e) {
      if (signal.aborted) return;
      // the record stays, carrying the reason: a toast would be gone before someone who walked away
      // from a long clone came back to it. `cancel-import` is how they dismiss it.
      pending.error = e instanceof Error ? e.message : String(e);
      tick(true);
    }
  }

  async register(rawPath: string, made?: RepoInfo["made"]): Promise<RepoInfo> {
    // typed into the project picker: "~/x" is how people write paths, and a shell never expanded it
    const path = expandTilde(rawPath);
    if (!existsSync(path)) throw new UserError(`${path} does not exist`);
    if (!(await isGitRepo(path))) throw new UserError(`${path} is not a git repository`);
    const root = await repoRoot(path);
    const existing = this.d.state.repos.find((r) => r.path === root);
    if (existing) {
      // `toyon` in a repo you already opened: this is the project you are about to look at
      this.warm(existing.id);
      return existing;
    }

    const detected = detectConfig(root);
    const repo: RepoInfo = {
      id: shortId(),
      path: root,
      name: basename(root),
      defaultBranch: await defaultBranch(root),
      config: detected.config,
      needsSetup: detected.needsSetup,
      guess: detected.from,
      ...(made ? { made } : {}),
      remote: await hasOrigin(root),
    };
    this.d.state.addRepo(repo);

    // the repo's own checkout is the "main" pseudo-worktree
    const main: WorktreeInfo = {
      id: shortId(),
      repoId: repo.id,
      path: root,
      branch: repo.defaultBranch,
      kind: "main",
      proxyPort: await allocateProxyPort(),
      // titled by repo so multi-repo lists don't show identical "main" rows
      title: repo.name,
      createdAt: Date.now(),
      // known before the first frame goes out: a project made from the picker opens greenfield
      empty: (await statusFiles(root)).length === 0 && (await treeEmpty(root)),
    };
    this.d.state.addWorktree(main);
    this.warmed.add(repo.id);
    await this.d.runtime.start(main, repo);
    this.startWatcher(repo);
    fireAndForget(repo.id, this.d.worktrees.spare.ensure(repo.id), "spare warm-up");
    this.d.hub.emit("reposChanged");
    this.d.hub.emit("worktreesChanged");
    return repo;
  }

  /** drop a repo from the daemon: its main runtime and spare stop, their records go, the checkout
   * stays untouched. Task worktrees are the person's work in progress, so a repo that still has
   * any is refused rather than silently removed with them. */
  async forget(repoId: string): Promise<void> {
    const repo = this.d.state.requireRepo(repoId);
    const mine = this.d.state.worktrees.filter((w) => w.repoId === repoId);
    const tasks = mine.filter((w) => w.kind !== "main" && w.kind !== "spare");
    if (tasks.length > 0) {
      throw new UserError(
        `${repo.name} still has ${tasks.length} worktree${tasks.length === 1 ? "" : "s"}; remove them first`,
      );
    }
    this.stopWatcher(repoId);
    for (const wt of mine.filter((w) => w.kind === "spare")) await this.d.worktrees.remove(wt.id, { spare: true });
    for (const wt of mine.filter((w) => w.kind === "main")) {
      await this.d.runtime.stop(wt.id);
      this.d.state.removeWorktree(wt.id);
      // main's chat has nowhere to come back to: opening the project again makes a new main
      this.d.worktrees.deleteChat(wt.id);
      releasePort(wt.proxyPort);
    }
    this.d.state.removeRepo(repoId);
    this.d.hub.emit("reposChanged");
    this.d.hub.emit("worktreesChanged");
  }

  confirmConfig(repoId: string, config: ToyonConfig) {
    const repo = this.d.state.requireRepo(repoId);
    repo.config = config;
    repo.needsSetup = false;
    repo.guess = undefined;
    this.d.state.save();
    // persist next to the code so it's shared/committed and future registers skip the card
    try {
      writeFileSync(join(repo.path, "toyon.json"), `${JSON.stringify(config, null, 2)}\n`);
    } catch (e) {
      log.warn(repoId, "could not write toyon.json", e);
    }
    // (re)start procs for this repo's worktrees — spares included, or a spare warmed under the old
    // config would be handed to the next task with stale procs; agents stay. Every worktree, cold
    // ones too: the person is sitting in front of this repo's setup pane.
    this.warmed.add(repoId);
    for (const wt of this.d.state.worktrees.filter((w) => w.repoId === repoId)) {
      fireAndForget(
        wt.id,
        this.d.runtime.stopProcs(wt.id).then(() => this.d.runtime.start(wt, repo)),
        "runtime restart",
      );
    }
    fireAndForget(repoId, this.d.worktrees.spare.ensure(repoId), "spare warm-up");
    this.d.hub.emit("reposChanged");
    this.d.hub.emit("worktreesChanged");
  }

  /** toyon.json changed on disk (an editor, the agent, a checkout): take it as the config. Profiles
   * are file-only, so without this a JSON edit would be invisible until the repo was re-registered.
   * A broken file keeps the last good config and says so in the main worktree's log. */
  reloadConfig(repoId: string) {
    const repo = this.d.state.requireRepo(repoId);
    if (!this.applyConfigFile(repo, true)) return;
    // only what is running comes back under the new file; a cold worktree stays cold and reads
    // the file when it is opened
    for (const wt of this.d.state.worktrees.filter((w) => w.repoId === repoId && this.d.runtime.get(w.id)?.procs)) {
      fireAndForget(
        wt.id,
        this.d.runtime.stopProcs(wt.id).then(() => this.d.runtime.start(wt, repo)),
        "runtime restart",
      );
    }
    if (this.warmed.has(repoId)) fireAndForget(repoId, this.d.worktrees.spare.ensure(repoId), "spare warm-up");
    this.d.hub.emit("reposChanged");
    this.d.hub.emit("worktreesChanged");
  }

  /** An unconfirmed repo re-reads its guess after every agent turn: the agent may have written
   * toyon.json, in which case it applies like any hand-written file, or it may have scaffolded
   * something detection recognises, in which case the setup pane comes back prefilled. Never a
   * confirmed repo: its file is the config, and only the watcher replaces it. The guess is never
   * confirmed here either; the person does that. Detection is a few existsSync calls on the
   * worktree the turn ran in, which is where the scaffold is. */
  private redetect(worktreeId: string) {
    const wt = this.d.state.worktree(worktreeId);
    const repo = wt && this.d.state.repo(wt.repoId);
    if (!wt || !repo?.needsSetup) return;
    if (readConfigFile(repo.path)?.ok) {
      this.reloadConfig(repo.id);
      return;
    }
    const detected = detectConfig(wt.path);
    if (JSON.stringify(detected.config) === JSON.stringify(repo.config) && detected.from === repo.guess) return;
    repo.config = detected.config;
    repo.guess = detected.from;
    this.d.state.save();
    this.d.hub.emit("reposChanged");
  }

  /** read the file into the repo record; true when the config actually changed */
  private applyConfigFile(repo: RepoInfo, announce: boolean): boolean {
    const file = readConfigFile(repo.path);
    if (!file) return false; // deleted or never written: keep what we have
    if (!file.ok) {
      log.warn(repo.id, file.reason);
      if (announce) {
        const main = this.d.state.worktrees.find((w) => w.repoId === repo.id && w.kind === "main");
        if (main) this.d.hub.emit("log", main.id, "config", `${file.reason}; keeping the previous config`);
      }
      return false;
    }
    const same = !repo.needsSetup && JSON.stringify(repo.config) === JSON.stringify(file.config);
    if (same) return false;
    repo.config = file.config;
    repo.needsSetup = false;
    repo.guess = undefined;
    this.d.state.save();
    return true;
  }

  private startWatcher(repo: RepoInfo) {
    if (this.watchers.has(repo.id)) return;
    const stopRef = watchDefaultBranch(repo.path, repo.defaultBranch, () => {
      this.d.worktrees.invalidateCounts();
      this.d.hub.emit("repoTick", repo.id);
      fireAndForget(repo.id, this.d.worktrees.spare.refresh(repo.id), "spare refresh");
    });
    const stopCfg = watchConfigFile(repo.path, () => this.reloadConfig(repo.id));
    // someone added or removed a worktree outside toyon: what git knows and what we last read
    // have diverged, and the rail's discovered section is what goes stale
    const stopWt = watchWorktreeDir(repo.path, () => {
      this.d.worktrees.invalidateDiscovered();
      this.d.hub.emit("worktreesChanged");
    });
    this.watchers.set(repo.id, () => {
      stopRef();
      stopCfg();
      stopWt();
    });
  }

  private stopWatcher(repoId: string) {
    this.watchers.get(repoId)?.();
    this.watchers.delete(repoId);
  }

  stopWatchers() {
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
  }
}
