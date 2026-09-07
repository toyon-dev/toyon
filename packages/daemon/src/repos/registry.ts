// Repos: registration, config confirmation, default-branch watchers, and boot (bring every
// persisted repo and worktree back up).

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RepoInfo, ToyonConfig, WorktreeInfo } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { defaultBranch, isGitRepo, repoRoot } from "../git/exec.ts";
import { allocateProxyPort, releasePort, reservePort } from "../runtime/ports.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { shortId } from "../worktrees/naming.ts";
import type { WorktreeService } from "../worktrees/service.ts";
import { detectConfig, readConfigFile } from "./config.ts";
import { watchConfigFile, watchDefaultBranch } from "./watcher.ts";

export interface RepoRegistryDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  worktrees: WorktreeService;
}

export class RepoRegistry {
  private watchers = new Map<string, () => void>();

  constructor(private d: RepoRegistryDeps) {}

  /** restart runtimes for persisted worktrees whose paths still exist, then watchers and spares */
  async boot(): Promise<void> {
    const { state, runtime } = this.d;
    state.pruneWorktrees((wt) => existsSync(wt.path) && state.repos.some((r) => r.id === wt.repoId));
    // toyon.json may have been edited while the daemon was down
    for (const repo of state.repos) this.applyConfigFile(repo, false);
    for (const wt of state.worktrees) reservePort(wt.proxyPort);
    for (const wt of state.worktrees) {
      await runtime.start(wt, state.requireRepo(wt.repoId));
    }
    state.save();
    for (const repo of state.repos) {
      this.startWatcher(repo);
      this.d.worktrees.spare.adoptOrCreate(repo.id);
    }
  }

  async register(rawPath: string): Promise<RepoInfo> {
    // typed into the project picker: "~/x" is how people write paths, and a shell never expanded it
    const path = rawPath === "~" || rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(1)) : rawPath;
    if (!existsSync(path)) throw new UserError(`${path} does not exist`);
    if (!(await isGitRepo(path))) throw new UserError(`${path} is not a git repository`);
    const root = await repoRoot(path);
    const existing = this.d.state.repos.find((r) => r.path === root);
    if (existing) return existing;

    const detected = detectConfig(root);
    const repo: RepoInfo = {
      id: shortId(),
      path: root,
      name: basename(root),
      defaultBranch: await defaultBranch(root),
      config: detected.config,
      needsSetup: detected.needsSetup,
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
    };
    this.d.state.addWorktree(main);
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
    for (const wt of mine.filter((w) => w.kind === "spare")) await this.d.worktrees.remove(wt.id, true);
    for (const wt of mine.filter((w) => w.kind === "main")) {
      await this.d.runtime.stop(wt.id);
      this.d.state.removeWorktree(wt.id);
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
    this.d.state.save();
    // persist next to the code so it's shared/committed and future registers skip the card
    try {
      writeFileSync(join(repo.path, "toyon.json"), `${JSON.stringify(config, null, 2)}\n`);
    } catch (e) {
      log.warn(repoId, "could not write toyon.json", e);
    }
    // (re)start procs for this repo's worktrees — spares included, or a spare warmed under the old
    // config would be handed to the next task with stale procs; agents stay
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

  /** read the file into the repo record; true when the config actually changed */
  private applyConfigFile(repo: RepoInfo, announce: boolean): boolean {
    const file = readConfigFile(repo.path);
    if (!file) return false; // deleted or never written: keep what we have
    if (!file.ok) {
      log.warn(repo.id, file.reason);
      if (announce) {
        const main = this.d.state.worktrees.find((w) => w.repoId === repo.id && w.kind === "main");
        if (main) this.d.hub.emit("log", main.id, "config", `${file.reason} — keeping the previous config`);
      }
      return false;
    }
    const same = !repo.needsSetup && JSON.stringify(repo.config) === JSON.stringify(file.config);
    if (same) return false;
    repo.config = file.config;
    repo.needsSetup = false;
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
    this.watchers.set(repo.id, () => {
      stopRef();
      stopCfg();
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
