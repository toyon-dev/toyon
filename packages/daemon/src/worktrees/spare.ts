// Spare pool: one pre-warmed worktree per repo (deps cloned, setup run, servers started) so a new
// task starts in seconds. Claiming hands the spare's runtime AND its agent to the task.
//
// The placeholder entry ({worktreeId:"", ready:false}) goes in before the first await so a second
// ensure() during warm-up is a no-op; refresh() and claim() key off `ready`.

import { join } from "node:path";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { git, gitOrThrow, lockfileHash, run } from "../git/exec.ts";
import { withRepoLock } from "../git/lock.ts";
import { allocateProxyPort, releasePort } from "../runtime/ports.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { shortId } from "./naming.ts";

interface SpareEntry {
  worktreeId: string;
  lockHash: string;
  refreshing: Promise<void> | null;
  ready: boolean;
}

export interface SparePoolDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  paths: Paths;
  /** clone deps, run setup, start the runtime (WorktreeService owns it) */
  setupAndStart: (wt: WorktreeInfo, repo: RepoInfo) => Promise<void>;
  /** remove a worktree, spares allowed (WorktreeService owns it) */
  remove: (worktreeId: string) => Promise<void>;
}

export class SparePool {
  private spares = new Map<string, SpareEntry>();

  constructor(private d: SparePoolDeps) {}

  /** Reuse a persisted spare from a previous daemon run, else warm a fresh one. */
  adoptOrCreate(repoId: string) {
    const persisted = this.d.state.worktrees.filter((w) => w.repoId === repoId && w.kind === "spare");
    // keep at most one; stale extras are removed
    for (const extra of persisted.slice(1)) fireAndForget(extra.id, this.d.remove(extra.id), "stale spare removal");
    const spare = persisted[0];
    if (spare) {
      this.spares.set(repoId, {
        worktreeId: spare.id,
        lockHash: lockfileHash(spare.path),
        refreshing: null,
        ready: true,
      });
      fireAndForget(repoId, this.refresh(repoId), "spare refresh"); // main may have moved while the daemon was down
    } else {
      fireAndForget(repoId, this.ensure(repoId), "spare warm-up");
    }
  }

  async ensure(repoId: string): Promise<void> {
    if (this.spares.has(repoId)) return;
    const repo = this.d.state.requireRepo(repoId);
    if (repo.needsSetup) return; // don't run guessed setup commands
    const entry: SpareEntry = { worktreeId: "", lockHash: "", refreshing: null, ready: false };
    this.spares.set(repoId, entry);
    try {
      const slug = `spare-${shortId().slice(0, 4)}`;
      const wtPath = join(this.d.paths.worktreesDir, repo.name, slug);
      await withRepoLock(repo.path, () =>
        gitOrThrow(repo.path, "worktree", "add", "--detach", wtPath, repo.defaultBranch),
      );
      const wt: WorktreeInfo = {
        id: shortId(),
        repoId,
        path: wtPath,
        branch: repo.defaultBranch,
        kind: "spare",
        proxyPort: await allocateProxyPort(),
        title: slug,
        createdAt: Date.now(),
      };
      entry.worktreeId = wt.id;
      this.d.state.addWorktree(wt);
      await this.d.setupAndStart(wt, repo); // CoW deps + setup + warm servers
      entry.lockHash = lockfileHash(wt.path);
      entry.ready = true;
    } catch (e) {
      log.warn(repoId, "spare warm-up failed; rolling back", e);
      this.spares.delete(repoId);
      // the state row and git worktree were created before setup could fail: undo them, or the
      // next boot adopts a half-built spare
      const wt = entry.worktreeId ? this.d.state.worktree(entry.worktreeId) : undefined;
      if (wt) {
        await this.d.runtime.stop(wt.id);
        await withRepoLock(repo.path, () => git(repo.path, "worktree", "remove", "--force", wt.path));
        this.d.state.removeWorktree(wt.id);
        releasePort(wt.proxyPort);
      }
    }
  }

  /** main moved: reset the spare onto it; re-run setup only when a lockfile changed */
  async refresh(repoId: string): Promise<void> {
    const entry = this.spares.get(repoId);
    if (!entry?.ready || entry.refreshing) return;
    const repo = this.d.state.requireRepo(repoId);
    const wt = this.d.state.worktree(entry.worktreeId);
    if (wt?.kind !== "spare") return;
    entry.refreshing = (async () => {
      await withRepoLock(repo.path, () => git(wt.path, "reset", "--hard", repo.defaultBranch));
      const h = lockfileHash(wt.path);
      if (h !== entry.lockHash) {
        entry.lockHash = h;
        for (const cmd of repo.config.setup ?? []) {
          const r = await run("sh", ["-c", cmd], wt.path);
          if (!r.ok) log.warn(wt.id, `spare setup failed: ${cmd}`, r.err);
        }
      }
    })().finally(() => {
      entry.refreshing = null;
    });
    await entry.refreshing;
  }

  /** Claim the warm spare for a new task: branch it, return it, warm the next. Null if none is ready. */
  async claim(repoId: string, branch: string, slug: string): Promise<WorktreeInfo | null> {
    const entry = this.spares.get(repoId);
    if (!entry?.ready) return null;
    this.spares.delete(repoId);
    // a refresh in flight serializes in front of the agent's first action
    if (entry.refreshing) await entry.refreshing;
    const wt = this.d.state.worktree(entry.worktreeId);
    if (wt?.kind !== "spare") return null;
    const repo = this.d.state.requireRepo(repoId);
    await withRepoLock(repo.path, () => gitOrThrow(wt.path, "switch", "-c", branch));
    wt.kind = "worktree";
    wt.branch = branch;
    wt.title = slug;
    wt.createdAt = Date.now();
    this.d.state.save();
    fireAndForget(
      repoId,
      this.ensure(repoId).then(() => this.d.hub.emit("worktreesChanged")),
      "spare warm-up",
    );
    return wt;
  }
}
