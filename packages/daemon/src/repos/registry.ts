// Repos: registration, config confirmation, default-branch watchers, and boot (bring every
// persisted repo and worktree back up).

import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OrchardistConfig, RepoInfo, WorktreeInfo } from "@orchardist/shared";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { defaultBranch, isGitRepo, repoRoot } from "../git/exec.ts";
import { allocateProxyPort, reservePort } from "../runtime/ports.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { shortId } from "../worktrees/naming.ts";
import type { WorktreeService } from "../worktrees/service.ts";
import { detectConfig } from "./config.ts";
import { watchDefaultBranch } from "./watcher.ts";

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

  async register(path: string): Promise<RepoInfo> {
    if (!isGitRepo(path)) throw new UserError(`${path} is not a git repository`);
    const root = repoRoot(path);
    const existing = this.d.state.repos.find((r) => r.path === root);
    if (existing) return existing;

    const detected = detectConfig(root);
    const repo: RepoInfo = {
      id: shortId(),
      path: root,
      name: basename(root),
      defaultBranch: defaultBranch(root),
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
    this.d.hub.emit("worktreesChanged");
    return repo;
  }

  confirmConfig(repoId: string, config: OrchardistConfig) {
    const repo = this.d.state.requireRepo(repoId);
    repo.config = config;
    repo.needsSetup = false;
    this.d.state.save();
    // persist next to the code so it's shared/committed and future registers skip the card
    try {
      writeFileSync(join(repo.path, "orchardist.json"), `${JSON.stringify(config, null, 2)}\n`);
    } catch (e) {
      log.warn(repoId, "could not write orchardist.json", e);
    }
    // (re)start procs for this repo's worktrees under the confirmed config; agents stay
    for (const wt of this.d.state.worktrees.filter((w) => w.repoId === repoId && w.kind !== "spare")) {
      fireAndForget(
        wt.id,
        this.d.runtime.stopProcs(wt.id).then(() => this.d.runtime.start(wt, repo)),
        "runtime restart",
      );
    }
    fireAndForget(
      repoId,
      this.d.worktrees.spare.ensure(repoId).then(() => this.d.hub.emit("worktreesChanged")),
      "spare warm-up",
    );
    this.d.hub.emit("worktreesChanged");
  }

  private startWatcher(repo: RepoInfo) {
    if (this.watchers.has(repo.id)) return;
    this.watchers.set(
      repo.id,
      watchDefaultBranch(repo.path, repo.defaultBranch, () => {
        this.d.worktrees.invalidateCounts();
        this.d.hub.emit("repoTick", repo.id);
        fireAndForget(repo.id, this.d.worktrees.spare.refresh(repo.id), "spare refresh");
      }),
    );
  }

  stopWatchers() {
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
  }
}
