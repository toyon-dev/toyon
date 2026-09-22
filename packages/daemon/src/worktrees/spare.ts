// Spare pool: one pre-warmed worktree per repo (deps cloned, setup run, servers started) so a new
// task starts in seconds. The spare is the row new work is typed in, and claiming turns that row
// into the task in place: its runtime AND its agent go to the task under the same id.
//
// A spare is a worktree record with a phase, and the phase is the whole of its state: `reserved`
// (the record exists, so the row does, and its git worktree is there or on its way), `warming`
// (deps, setup and servers under way) and `ready`. The record is persisted with its phase, so a
// daemon that restarts picks a half-made spare up where it was. The pool holds nothing a record
// does not say, except the promises that in-flight work is joined on.
//
// A claim is a kind change, whatever the phase: setup, if still running, is keyed on the record
// and runs on for the task. The claim also reserves the next spare, in the same frame that names
// the task, so the plus never leaves the rail and main never stands in; that spare's finish waits
// until the claimed one's preview has answered (or a few seconds), so its boot never shares the
// core with the send the person is waiting on.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { git, gitOrThrow, lockfileHash } from "../git/exec.ts";
import { withRepoLock } from "../git/lock.ts";
import { STAGGER_MS } from "../runtime/idle.ts";
import { allocateProxyPort, releasePort } from "../runtime/ports.ts";
import { type RuntimeRegistry, worktreeEnv } from "../runtime/registry.ts";
import { runSetup } from "../runtime/setup.ts";
import { freeSlot } from "./naming.ts";

/** the warm-up under way for a repo: the git worktree, then the whole of it. `cut` ends the wait
 * on the previous task's preview, for a claim that will not sit through it. */
interface Inflight {
  added: Promise<void>;
  done: Promise<void>;
  cut: () => void;
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
  /** the repo's spare is up: main's own procs, if any were running, are the second copy now */
  ready?: (repoId: string) => void;
}

export class SparePool {
  private inflight = new Map<string, Inflight>();
  private refreshing = new Map<string, Promise<void>>();

  constructor(private d: SparePoolDeps) {}

  /** the repo's spare record, whatever its phase */
  private spareOf(repoId: string): WorktreeInfo | undefined {
    return this.d.state.worktrees.find((w) => w.repoId === repoId && w.kind === "spare");
  }

  /** the repo's spare as the pool sees it: null while the repo has none, which is when main leads */
  current(repoId: string): { worktreeId: string; ready: boolean } | null {
    const wt = this.spareOf(repoId);
    return wt ? { worktreeId: wt.id, ready: wt.phase === "ready" } : null;
  }

  /** Words are being typed into a box. On the plus that is the earliest sign a send is coming, so
   * the spare's agent starts now and enter meets a process that is up: the adapter's boot is the
   * seconds before the first token. The agent needs the directory and nothing else in it, so a
   * spare still warming counts; any box that is not a spare's is nothing to the pool. */
  typed(boxId: string, text: string): void {
    if (!text.trim()) return;
    const wt = this.d.state.worktree(boxId);
    if (wt?.kind !== "spare" || !existsSync(wt.path)) return;
    const agent = this.d.runtime.ensureAgent(wt).agent;
    if (agent.runningAgent === null) fireAndForget(wt.id, agent.warm(), "warm on the first keystroke");
  }

  /** Take over the spares persisted by a previous daemon run, without touching them: bookkeeping
   * only, so boot stays cheap. Stale extras are removed. `warm` is what brings the one kept up to
   * date, from whatever phase it was left in. */
  adopt(repoId: string) {
    const persisted = this.d.state.worktrees.filter((w) => w.repoId === repoId && w.kind === "spare");
    // keep at most one; stale extras are removed
    for (const extra of persisted.slice(1)) fireAndForget(extra.id, this.d.discard(extra.id), "stale spare removal");
    const spare = persisted[0];
    if (!spare) return;
    // a record from before phases were written was only ever saved once ready
    spare.phase ??= "ready";
    spare.lockfile ??= lockfileHash(spare.path);
  }

  /** the repo is in use: refresh its adopted spare (main may have moved while the daemon was
   * down), finish one left half-made, or warm a fresh one when there is none */
  warm(repoId: string) {
    const wt = this.spareOf(repoId);
    if (wt?.phase === "ready") fireAndForget(repoId, this.revive(repoId), "spare refresh");
    else fireAndForget(repoId, this.ensure(repoId), "spare warm-up");
  }

  /** an adopted spare, brought back to warm: reset onto main, then its procs and proxy up, since
   * a spare with no preview is not warm (the draft tab shows it, and a claim hands it over as is;
   * before this the procs waited for the first subscribe after the claim) */
  private async revive(repoId: string): Promise<void> {
    await this.refresh(repoId);
    const wt = this.spareOf(repoId);
    if (wt?.phase !== "ready" || this.d.runtime.get(wt.id)?.procs) return;
    await this.d.runtime.start(wt, this.d.state.requireRepo(repoId));
  }

  /** See that the repo has a spare: the one there is, or a warm-up started now. Resolves once it
   * is ready, or once the warm-up has been rolled back. */
  ensure(repoId: string): Promise<void> {
    const running = this.inflight.get(repoId);
    if (running) return running.done;
    const have = this.spareOf(repoId);
    if (have?.phase === "ready") return Promise.resolve();
    const repo = this.d.state.requireRepo(repoId);
    // a half-made spare from a previous run picks up where it was
    if (have) return this.warmUp(have, repo, {});
    if (repo.needsSetup) return Promise.resolve(); // don't run guessed setup commands
    return this.record(repoId, repo).then((wt) => this.warmUp(wt, repo, {}));
  }

  /** the record, and so the row: in state before anything is awaited on it, since the frame that
   * names a task reads the list as it stands */
  private async record(repoId: string, repo: RepoInfo): Promise<WorktreeInfo> {
    // the directory name outlives the spare: a claim keeps it, so it must not say "spare"
    const { id, dir } = freeSlot(join(this.d.paths.worktreesDir, repo.name));
    const wt: WorktreeInfo = {
      id,
      repoId,
      path: join(this.d.paths.worktreesDir, repo.name, dir),
      branch: repo.defaultBranch,
      kind: "spare",
      phase: "reserved",
      proxyPort: await allocateProxyPort(),
      title: dir,
      createdAt: Date.now(),
    };
    this.d.state.addWorktree(wt);
    return wt;
  }

  /** the slow part, on a record that exists (a live reference: a claim changes its kind under
   * this, and from then on the finish is the task's and the pool marks nothing). `after` names
   * the task whose preview the finish waits on. */
  private warmUp(wt: WorktreeInfo, repo: RepoInfo, { after }: { after?: string }): Promise<void> {
    const repoId = repo.id;
    let cut = () => {};
    const added = (async () => {
      if (existsSync(wt.path)) return;
      await withRepoLock(repo.path, () =>
        gitOrThrow(repo.path, "worktree", "add", "--detach", wt.path, repo.defaultBranch),
      );
    })();
    const done = (async () => {
      try {
        await added;
        if (after) {
          await Promise.race([
            this.d.runtime.awaitPreview(after, STAGGER_MS),
            new Promise<void>((r) => {
              cut = r;
            }),
          ]);
        }
        // discarded while it waited
        if (!this.d.state.worktree(wt.id)) return;
        if (wt.kind === "spare") {
          wt.phase = "warming";
          this.d.state.save();
          this.d.hub.emit("worktreesChanged");
          // main may have moved while the finish waited; refresh() passes a spare that is not ready
          await withRepoLock(repo.path, () => git(wt.path, "reset", "--hard", repo.defaultBranch));
        }
        await this.d.setupAndStart(wt, repo); // CoW deps + setup + warm servers
        // claimed while finishing: the task's procs are up, and the pool has moved on
        if (wt.kind !== "spare") return;
        wt.lockfile = lockfileHash(wt.path);
        wt.phase = "ready";
        this.d.state.save();
        this.d.ready?.(repoId);
        // the frame that says the spare is ready: the runtime's own emit went out before this flag
        this.d.hub.emit("worktreesChanged");
      } catch (e) {
        await this.rollBack(wt, e);
      } finally {
        if (this.inflight.get(repoId)?.added === added) this.inflight.delete(repoId);
      }
    })();
    this.inflight.set(repoId, { added, done, cut: () => cut() });
    return done;
  }

  private async rollBack(wt: WorktreeInfo, e: unknown): Promise<void> {
    // a task by now: its setup failed the way any worktree's can, and the row stays for the
    // person to read what happened
    if (wt.kind !== "spare") {
      log.warn(wt.id, "setup failed after the spare was claimed", e);
      return;
    }
    log.warn(wt.repoId, "spare warm-up failed; rolling back", e);
    // the state row and git worktree were created before setup could fail: undo them, or the
    // next boot adopts a half-built spare. The row was on screen while it warmed, so words typed
    // into its box move to the row that takes its place before the box goes with it.
    this.d.carryDraft?.(wt.id, wt.repoId);
    if (existsSync(wt.path)) {
      await this.d.discard(wt.id).catch((re) => log.warn(wt.repoId, "spare rollback failed", re));
      return;
    }
    // the add itself failed: a record and a port, nothing on disk
    this.d.state.removeWorktree(wt.id);
    releasePort(wt.proxyPort);
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** main moved: reset the spare onto it; re-run setup only when a lockfile changed. A spare not
   * ready gets its reset at the start of its finish instead. */
  async refresh(repoId: string): Promise<void> {
    const wt = this.spareOf(repoId);
    if (wt?.phase !== "ready" || this.refreshing.has(repoId)) return;
    const repo = this.d.state.requireRepo(repoId);
    const run = (async () => {
      await withRepoLock(repo.path, () => git(wt.path, "reset", "--hard", repo.defaultBranch));
      const h = lockfileHash(wt.path);
      if (h !== wt.lockfile) {
        wt.lockfile = h;
        this.d.state.save();
        for (const cmd of repo.config.setup ?? []) {
          // nobody is watching a spare, so its output goes to the daemon log rather than the hub
          const tail: string[] = [];
          // the spare keeps its id when claimed, so a database this names is the task's later
          const code = await runSetup(
            cmd,
            wt.path,
            (line, retract) => {
              tail.splice(Math.max(0, tail.length - retract), retract);
              if (line) tail.push(line);
              if (tail.length > 20) tail.shift();
            },
            worktreeEnv(wt, repo),
          );
          if (code !== 0) log.warn(wt.id, `spare setup failed (exit ${code}): ${cmd}`, tail.join("\n"));
        }
      }
    })().finally(() => {
      this.refreshing.delete(repoId);
    });
    this.refreshing.set(repoId, run);
    await run;
  }

  /** Claim the spare for a new task: branch it, on `toyon/<its directory>` until it is named, and
   * return it. Null if there is none, or if the row named is not the pool's. `worktreeId` names
   * the row the message was typed in: one still warming is claimed as it is, since the person is
   * looking at it, and its finish runs on for the task; a row nobody named takes the spare only
   * once it is ready. A row already claimed by another tab is nobody's to wait for, and null sends
   * the caller down the cold path. The next spare is reserved before this returns, so the frame
   * that names the task lists it. */
  async claim(repoId: string, title: string, worktreeId?: string): Promise<WorktreeInfo | null> {
    const wt = this.spareOf(repoId);
    if (!wt) return null;
    if (worktreeId && wt.id !== worktreeId) return null;
    const wasReady = wt.phase === "ready";
    if (!wasReady) {
      if (!worktreeId) return null;
      // the directory has to be there to branch; the add is the first thing a warm-up does, and
      // the wait for the previous task's preview is not the person's to sit through
      const running = this.inflight.get(repoId);
      await running?.added.catch(() => {});
      running?.cut();
      if (wt.kind !== "spare" || !existsSync(wt.path)) return null;
    }
    // a refresh in flight serializes in front of the agent's first action
    await this.refreshing.get(repoId);
    const repo = this.d.state.requireRepo(repoId);
    // a switch that fails changes nothing: the spare stays the spare, and git's words go up
    const branch = `toyon/${basename(wt.path)}`;
    await withRepoLock(repo.path, () => gitOrThrow(wt.path, "switch", "-c", branch));
    wt.kind = "worktree";
    delete wt.phase;
    delete wt.lockfile;
    wt.branch = branch;
    // the title is the prompt's first words until the task is named
    wt.title = title;
    wt.unnamed = true;
    wt.createdAt = Date.now();
    // a spare that rested with its repo comes up for the task it now is; one still warming gets
    // its start at the end of its own finish rather than from a wake onto a tree with no deps yet
    if (wasReady) fireAndForget(wt.id, this.d.runtime.wake(wt.id), "wake on claim");
    // the next row, in the same frame; its finish waits for this task's preview
    const next = repo.needsSetup ? null : await this.record(repoId, repo);
    this.d.state.save();
    if (next) fireAndForget(repoId, this.warmUp(next, repo, { after: wt.id }), "spare reserve");
    return wt;
  }
}
