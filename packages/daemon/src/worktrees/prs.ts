// What GitHub says about the PRs toyon opened: read after a PR opens or is merged, when the window
// comes back (repoTick), and every few minutes while any PR of a repo is open. A merged PR is what
// lands the worktree on the PR route: main here takes it and the row is marked landed, the same
// ending as the local routes.

import type { PrState } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { WorktreeService } from "./service.ts";

export interface PrServiceDeps {
  state: StateStore;
  hub: Hub;
  worktrees: Pick<WorktreeService, "setPr" | "prMerged">;
  /** one PR as GitHub has it now, or null when gh cannot say (tests feed JSON here) */
  view: (repoPath: string, number: number) => Promise<PrState | null>;
  /** how often an open PR is asked about on its own; the window coming back asks sooner */
  everyMs?: number;
}

const POLL_MS = 3 * 60_000;

export class PrService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** worktrees whose PR is being read now, so a focus during a poll does not ask twice */
  private reading = new Set<string>();

  constructor(private d: PrServiceDeps) {
    d.hub.on("repoTick", (repoId) => this.refreshRepo(repoId));
    // unref'd: a daemon with nothing else to do should still exit, and the ticks matter only while
    // someone is looking anyway (the frame they push reaches no one otherwise)
    this.timer = setInterval(() => this.refreshAll(), d.everyMs ?? POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refreshAll() {
    for (const repo of this.d.state.repos) this.refreshRepo(repo.id);
  }

  refreshRepo(repoId: string) {
    for (const wt of this.d.state.worktrees) {
      if (wt.repoId === repoId && wt.pr?.state === "open") fireAndForget(wt.id, this.refresh(wt.id), "pr refresh");
    }
  }

  /** ask GitHub about the worktree's PR and record the answer; a merge is the landing */
  async refresh(worktreeId: string): Promise<PrState | null> {
    const wt = this.d.state.worktree(worktreeId);
    const pr = wt?.pr;
    if (!wt || !pr || this.reading.has(worktreeId)) return pr ?? null;
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return pr;
    this.reading.add(worktreeId);
    try {
      const fresh = await this.d.view(repo.path, pr.number);
      // removed, or a new PR replaced this one while gh was answering
      const now = this.d.state.worktree(worktreeId);
      if (!fresh || !now || now.pr?.number !== pr.number) return fresh;
      this.d.worktrees.setPr(worktreeId, fresh);
      if (fresh.state === "merged" && !now.landed) {
        const r = await this.d.worktrees.prMerged(worktreeId);
        if (!r.ok) log.info(worktreeId, `PR #${pr.number} merged; main here did not follow: ${r.message}`);
      }
      return fresh;
    } finally {
      this.reading.delete(worktreeId);
    }
  }
}
