// What GitHub says about the PRs toyon opened: read after a PR opens or is merged, when the window
// comes back (repoTick), and every few minutes while any PR of a repo is open. A merged PR is the
// landing on the PR route, wherever it was merged from: the row is marked landed and main here
// follows origin as far as it can, the same ending as the local routes. While a PR is open the same
// read brings in what reviewers wrote on it, for the page the line over the box opens; a remark
// someone else wrote rings the worktree, once.

import { type PrComment, type PrState, prTaken } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { WorktreeService } from "./service.ts";

export interface PrServiceDeps {
  state: StateStore;
  hub: Hub;
  worktrees: Pick<WorktreeService, "setPr" | "prMerged">;
  /** one PR as GitHub has it now, or null when gh cannot say (tests feed JSON here) */
  view: (repoPath: string, number: number) => Promise<PrState | null>;
  /** the PR's line comments and reviews, oldest first, or null when gh cannot say */
  comments?: (repoPath: string, number: number) => Promise<PrComment[] | null>;
  /** who gh is signed in as on a host: their own remarks are not news to them */
  login?: (repoPath: string, host: string) => Promise<string | null>;
  /** how often an open PR is asked about on its own; the window coming back asks sooner */
  everyMs?: number;
}

const POLL_MS = 3 * 60_000;

export class PrService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** worktrees whose PR is being read now, so a focus during a poll does not ask twice */
  private reading = new Set<string>();
  /** worktrees whose PR remarks are being read now, apart from the PR itself, which waits on nothing */
  private commenting = new Set<string>();
  /** the signed-in login per host, asked once; a failed ask is asked again next time */
  private me = new Map<string, Promise<string | null>>();

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
      if (wt.repoId !== repoId || !wt.pr) continue;
      if (wt.pr.state === "open") fireAndForget(wt.id, this.refresh(wt.id), "pr refresh");
      // merged while an op was out on the row, so its landing was left to that press: taken now,
      // with nothing to ask GitHub
      else if (wt.pr.state === "merged" && !prTaken(wt)) {
        fireAndForget(wt.id, this.d.worktrees.prMerged(wt.id), "pr landing");
      }
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
      // after the PR is recorded and apart from it: a slow or failed read of the remarks never
      // holds up what the composer says about the PR
      if (fresh.state === "open") fireAndForget(worktreeId, this.readComments(worktreeId), "pr comments");
      // the landing says how it went in the log itself
      if (fresh.state === "merged" && !prTaken(now)) await this.d.worktrees.prMerged(worktreeId);
      return fresh;
    } finally {
      this.reading.delete(worktreeId);
    }
  }

  /** Read the remarks on the worktree's open PR and keep them for its page; when they changed, the
   * summary on the worktree moves and goes out with the rows. A remark someone else wrote since the
   * last read rings the worktree, the way a turn that ended unseen does; one from before Toyon first
   * read any does not, nor does the person's own. */
  async readComments(worktreeId: string): Promise<void> {
    const { comments } = this.d;
    const wt = this.d.state.worktree(worktreeId);
    const pr = wt?.pr;
    if (!comments || !wt || pr?.state !== "open" || this.commenting.has(worktreeId)) return;
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return;
    this.commenting.add(worktreeId);
    try {
      const [me, all] = await Promise.all([this.login(repo.path, hostOf(pr.url)), comments(repo.path, pr.number)]);
      // with no login to tell them apart, the person's own remarks would ring for them
      if (!me || !all) return;
      const now = this.d.state.worktree(worktreeId);
      if (!now || now.pr?.number !== pr.number) return;
      const rec = this.d.state.prCommentsOf(worktreeId);
      const before = rec?.pr === pr.number ? rec.comments : [];
      if (JSON.stringify(before) === JSON.stringify(all)) return;
      const had = new Set(before.map((c) => c.id));
      const from = this.d.state.prCommentsFrom(Date.now());
      const mine = me.toLowerCase();
      const theirs = (c: PrComment) => c.author.toLowerCase() !== mine;
      const fresh = all.some((c) => !had.has(c.id) && c.at > from && theirs(c));
      this.d.state.setPrComments(worktreeId, { pr: pr.number, comments: all });
      const authors = [
        ...new Set(
          all
            .filter(theirs)
            .map((c) => c.author)
            .reverse(),
        ),
      ];
      now.prComments = { pr: pr.number, count: all.length, authors, version: (now.prComments?.version ?? 0) + 1 };
      if (fresh) now.unread = true;
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
    } finally {
      this.commenting.delete(worktreeId);
    }
  }

  /** the remarks the worktree's page shows: its open PR's, as last read */
  commentsOf(worktreeId: string): PrComment[] {
    const pr = this.d.state.worktree(worktreeId)?.pr;
    const rec = this.d.state.prCommentsOf(worktreeId);
    return pr?.state === "open" && rec?.pr === pr.number ? rec.comments : [];
  }

  private login(repoPath: string, host: string): Promise<string | null> {
    const ask = this.d.login;
    if (!ask) return Promise.resolve(null);
    let asked = this.me.get(host);
    if (!asked) {
      asked = ask(repoPath, host).then((login) => {
        if (!login) this.me.delete(host);
        return login;
      });
      this.me.set(host, asked);
    }
    return asked;
  }
}

/** the host a PR's URL is on: github.com, or an Enterprise server's own name */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "github.com";
  } catch {
    // not a URL: gh falls back to github.com when it is not told otherwise, and so does this
    return "github.com";
  }
}
