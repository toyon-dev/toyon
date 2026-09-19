// Spare pool: one pre-warmed worktree per repo (deps cloned, setup run, servers started) so a new
// task starts in seconds. The spare is the row new work is typed in, and claiming turns that row
// into the task in place: its runtime AND its agent go to the task under the same id.
//
// The placeholder entry ({worktreeId:"", ready:false}) goes in before the first await so a second
// ensure() during warm-up joins the one running; refresh() and claim() key off `ready`.

import { join } from "node:path";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { git, gitOrThrow, lockfileHash } from "../git/exec.ts";
import { withRepoLock } from "../git/lock.ts";
import { allocateProxyPort } from "../runtime/ports.ts";
import { type RuntimeRegistry, worktreeEnv } from "../runtime/registry.ts";
import { runSetup } from "../runtime/setup.ts";
import { shortId } from "./naming.ts";

interface SpareEntry {
  worktreeId: string;
  lockHash: string;
  refreshing: Promise<void> | null;
  ready: boolean;
  /** the warm-up under way, for a claim of the row that arrives before it is ready */
  warming: Promise<void> | null;
}

export interface SparePoolDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  paths: Paths;
  /** clone deps, run setup, start the runtime (WorktreeService owns it) */
  setupAndStart: (wt: WorktreeInfo, repo: RepoInfo) => Promise<void>;
  /** discard a worktree, spares allowed (WorktreeService owns it) */
  discard: (worktreeId: string) => Promise<void>;
  /** a warm-up failed under someone's fingers: whatever was typed into the spare's box goes to the
   * row that stands in for it now (WorktreeService knows which) */
  carryDraft?: (fromId: string, repoId: string) => void;
}

export class SparePool {
  private spares = new Map<string, SpareEntry>();

  constructor(private d: SparePoolDeps) {}

  /** the repo's spare as the pool sees it: null before a warm-up has a record */
  current(repoId: string): { worktreeId: string; ready: boolean } | null {
    const entry = this.spares.get(repoId);
    return entry?.worktreeId ? { worktreeId: entry.worktreeId, ready: entry.ready } : null;
  }

  /** Take over a spare persisted by a previous daemon run, without touching it: bookkeeping only,
   * so boot stays cheap. Stale extras are removed. `warm` is what brings it up to date. */
  adopt(repoId: string) {
    const persisted = this.d.state.worktrees.filter((w) => w.repoId === repoId && w.kind === "spare");
    // keep at most one; stale extras are removed
    for (const extra of persisted.slice(1)) fireAndForget(extra.id, this.d.discard(extra.id), "stale spare removal");
    const spare = persisted[0];
    if (!spare) return;
    this.spares.set(repoId, {
      worktreeId: spare.id,
      lockHash: lockfileHash(spare.path),
      refreshing: null,
      ready: true,
      warming: null,
    });
  }

  /** the repo is in use: refresh its adopted spare (main may have moved while the daemon was
   * down), or warm a fresh one when there is none */
  warm(repoId: string) {
    if (this.spares.has(repoId)) fireAndForget(repoId, this.revive(repoId), "spare refresh");
    else fireAndForget(repoId, this.ensure(repoId), "spare warm-up");
  }

  /** an adopted spare, brought back to warm: reset onto main, then its procs and proxy up, since
   * a spare with no preview is not warm (the draft tab shows it, and a claim hands it over as is;
   * before this the procs waited for the first subscribe after the claim) */
  private async revive(repoId: string): Promise<void> {
    await this.refresh(repoId);
    const entry = this.spares.get(repoId);
    const wt = entry?.ready ? this.d.state.worktree(entry.worktreeId) : undefined;
    if (wt?.kind !== "spare" || this.d.runtime.get(wt.id)?.procs) return;
    await this.d.runtime.start(wt, this.d.state.requireRepo(repoId));
  }

  /** See that the repo has a spare: the one there is, or a warm-up started now. Resolves once it
   * is ready, or once the warm-up has been rolled back. */
  ensure(repoId: string): Promise<void> {
    const have = this.spares.get(repoId);
    if (have) return have.warming ?? Promise.resolve();
    const repo = this.d.state.requireRepo(repoId);
    if (repo.needsSetup) return Promise.resolve(); // don't run guessed setup commands
    const entry: SpareEntry = { worktreeId: "", lockHash: "", refreshing: null, ready: false, warming: null };
    this.spares.set(repoId, entry);
    entry.warming = this.warmUp(repoId, repo, entry).finally(() => {
      entry.warming = null;
    });
    return entry.warming;
  }

  private async warmUp(repoId: string, repo: RepoInfo, entry: SpareEntry): Promise<void> {
    try {
      // the directory name outlives the spare: a claim keeps it, so it must not say "spare"
      const slug = `wt-${shortId().slice(0, 4)}`;
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
      // the frame that says the spare is ready: the runtime's own emit went out before this flag
      this.d.hub.emit("worktreesChanged");
    } catch (e) {
      log.warn(repoId, "spare warm-up failed; rolling back", e);
      this.spares.delete(repoId);
      // the state row and git worktree were created before setup could fail: undo them, or the
      // next boot adopts a half-built spare. The row was on screen while it warmed, so words typed
      // into its box move to the row that takes its place before the box goes with it.
      if (entry.worktreeId && this.d.state.worktree(entry.worktreeId)) {
        this.d.carryDraft?.(entry.worktreeId, repoId);
        await this.d.discard(entry.worktreeId).catch((re) => log.warn(repoId, "spare rollback failed", re));
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
          // nobody is watching a spare, so its output goes to the daemon log rather than the hub
          const tail: string[] = [];
          // the spare keeps its id when claimed, so a database this names is the task's later
          const code = await runSetup(
            cmd,
            wt.path,
            (line) => {
              tail.push(line);
              if (tail.length > 20) tail.shift();
            },
            worktreeEnv(wt, repo),
          );
          if (code !== 0) log.warn(wt.id, `spare setup failed (exit ${code}): ${cmd}`, tail.join("\n"));
        }
      }
    })().finally(() => {
      entry.refreshing = null;
    });
    await entry.refreshing;
  }

  /** Claim the warm spare for a new task: branch it, return it, warm the next. Null if none is
   * ready. `worktreeId` names the row the message was typed in: a spare still warming is waited
   * for rather than passed over for a cold checkout, since the person is looking at it; one
   * already claimed by another tab is nobody's to wait for, and null sends the caller down the
   * cold path. */
  async claim(repoId: string, branch: string, title: string, worktreeId?: string): Promise<WorktreeInfo | null> {
    let entry = this.spares.get(repoId);
    if (worktreeId && entry?.worktreeId === worktreeId && !entry.ready && entry.warming) {
      await entry.warming;
      entry = this.spares.get(repoId);
    }
    if (!entry?.ready) return null;
    if (worktreeId && entry.worktreeId !== worktreeId) return null;
    this.spares.delete(repoId);
    // a refresh in flight serializes in front of the agent's first action
    if (entry.refreshing) await entry.refreshing;
    const wt = this.d.state.worktree(entry.worktreeId);
    if (wt?.kind !== "spare") return null;
    const repo = this.d.state.requireRepo(repoId);
    try {
      await withRepoLock(repo.path, () => gitOrThrow(wt.path, "switch", "-c", branch));
    } catch (e) {
      // the spare is still a good spare: put it back rather than leaving an invisible row
      this.spares.set(repoId, { ...entry, ready: true });
      throw e;
    }
    wt.kind = "worktree";
    wt.branch = branch;
    wt.title = title;
    wt.createdAt = Date.now();
    this.d.state.save();
    // a spare that rested with its repo comes up for the task it now is
    fireAndForget(wt.id, this.d.runtime.wake(wt.id), "wake on claim");
    fireAndForget(repoId, this.ensure(repoId), "spare warm-up");
    return wt;
  }
}
