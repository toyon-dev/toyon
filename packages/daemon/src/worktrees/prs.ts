// What GitHub says about the PRs of toyon's rows: read after a PR opens or is merged, when the
// window comes back (repoTick), when a row's work turns up on the base ahead of any word of a
// merge (prDue), and every few minutes while any PR of a repo is open. A PR GitHub itself is about
// to merge (in the merge queue, or on auto-merge with its checks still running) is asked about
// every half minute instead, while a shell is connected to see the answer: nobody presses anything
// for that merge, so the poll is the only way the row hears of it. A merged PR is the landing on
// the PR route, wherever it was merged from: the row is marked landed and main here follows origin
// as far as it can, the same ending as the local routes. While a PR is open the same read brings in
// what reviewers wrote on it, for the page the line over the box opens; a remark someone else
// wrote rings the worktree, once.
//
// A PR the land press did not open is found the same way. An agent that pushes its branch and runs
// `gh pr create` in the chat, or a person doing so in a terminal, leaves the row with no record,
// and the box offers to create a PR over one that exists, or over work a squash merge already put
// on main, which git alone cannot see (the branch stays ahead for good). So a row on the PR route
// with no PR, whose branch origin has a copy of, is asked about when its turn settles, when the
// window comes back, and on the poll; what GitHub answers goes on the record and the rest follows
// as for a PR toyon opened.

import { landPolicy, type PrComment, type PrState, prTaken, type WorktreeInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { FoundPr } from "../git/gh.ts";
import type { WorktreeService } from "./service.ts";

export interface PrServiceDeps {
  state: StateStore;
  hub: Hub;
  worktrees: Pick<WorktreeService, "setPr" | "prMerged">;
  /** one PR as GitHub has it now, or null when gh cannot say (tests feed JSON here) */
  view: (repoPath: string, number: number) => Promise<PrState | null>;
  /** the PR a branch is the head of, when GitHub has one; discovery is off without it */
  find?: (repoPath: string, branch: string) => Promise<FoundPr | null>;
  /** where origin's copy of a row's branch stands, or null when it was never pushed */
  remoteHead?: (worktreePath: string, branch: string) => Promise<string | null>;
  /** whether a commit is in the row's own history */
  reaches?: (worktreePath: string, sha: string) => Promise<boolean>;
  /** the PR's line comments and reviews, oldest first, or null when gh cannot say */
  comments?: (repoPath: string, number: number) => Promise<PrComment[] | null>;
  /** who gh is signed in as on a host: their own remarks are not news to them */
  login?: (repoPath: string, host: string) => Promise<string | null>;
  /** how often an open PR is asked about on its own; the window coming back asks sooner */
  everyMs?: number;
  /** how often a PR GitHub is about to merge is asked about, while someone is looking */
  fastMs?: number;
  /** whether any shell is connected to see the answer; the fast poll runs for no one otherwise */
  looking?: () => boolean;
}

const POLL_MS = 3 * 60_000;
const FAST_MS = 30_000;

/** GitHub holds the PR and will merge it without anyone pressing: it is in the merge queue, or
 * auto-merge is on and the checks it waits for are still running. Auto-merge waiting on a review
 * is not this: a person has to act, and the slow poll is enough until they do. */
export function heldByGitHub(pr: PrState): boolean {
  if (pr.state !== "open") return false;
  if (pr.queued === "waiting" || pr.queued === "checking" || pr.queued === "merging") return true;
  return !!pr.automerge && pr.checks === "pending";
}

export class PrService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fast: ReturnType<typeof setInterval> | null = null;
  /** worktrees whose PR is being read now, so a focus during a poll does not ask twice */
  private reading = new Set<string>();
  /** worktrees whose PR remarks are being read now, apart from the PR itself, which waits on nothing */
  private commenting = new Set<string>();
  /** the signed-in login per host, asked once; a failed ask is asked again next time */
  private me = new Map<string, Promise<string | null>>();
  /** rows whose branch is being looked up now */
  private finding = new Set<string>();
  /** rows asked for a PR GitHub had none of, or none the row could take, by the push they were
   * asked at and when: the same push is not asked about again until the poll comes round */
  private missed = new Map<string, { sha: string; at: number }>();

  constructor(private d: PrServiceDeps) {
    d.hub.on("repoTick", (repoId) => this.refreshRepo(repoId));
    // the push and the `gh pr create` happen inside a turn: its end is when the PR is there
    d.hub.on("turnSettled", (id) => fireAndForget(id, this.discover(id, "turn"), "pr discovery"));
    // a merge that kept the hashes reached the base here before GitHub was asked about it, and
    // git alone could not say the PR merged: the row's landing waits on the answer, asked for now
    d.hub.on("prDue", (id) => {
      const wt = this.d.state.worktree(id);
      if (wt) this.ask(wt);
    });
    // unref'd: a daemon with nothing else to do should still exit, and the ticks matter only while
    // someone is looking anyway (the frame they push reaches no one otherwise)
    this.timer = setInterval(() => this.refreshAll(), d.everyMs ?? POLL_MS);
    this.timer.unref?.();
    this.fast = setInterval(() => this.refreshHeld(), d.fastMs ?? FAST_MS);
    this.fast.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.fast) clearInterval(this.fast);
    this.fast = null;
  }

  refreshAll() {
    for (const repo of this.d.state.repos) this.refreshRepo(repo.id, "poll");
  }

  /** the PRs GitHub is about to merge, asked about again; nothing when no shell would see it */
  refreshHeld() {
    if (this.d.looking && !this.d.looking()) return;
    for (const wt of this.d.state.worktrees) {
      if (wt.pr && heldByGitHub(wt.pr)) fireAndForget(wt.id, this.refresh(wt.id), "pr refresh");
    }
  }

  refreshRepo(repoId: string, why: "tick" | "poll" = "tick") {
    for (const wt of this.d.state.worktrees) {
      if (wt.repoId !== repoId) continue;
      if (!wt.pr) fireAndForget(wt.id, this.discover(wt.id, why), "pr discovery");
      else this.ask(wt);
    }
  }

  /** One row's PR, where there is something left to hear: an open one is read again, and a
   * merged one no landing has taken is landed. A closed one, or one taken, is over. */
  private ask(wt: WorktreeInfo) {
    if (wt.pr?.state === "open") fireAndForget(wt.id, this.refresh(wt.id), "pr refresh");
    // merged while an op was out on the row, so its landing was left to that press: taken now,
    // with nothing to ask GitHub
    else if (wt.pr?.state === "merged" && !prTaken(wt)) {
      fireAndForget(wt.id, this.d.worktrees.prMerged(wt.id), "pr landing");
    }
  }

  /** Look for the PR a row's branch is the head of, when the row has no record of one and the
   * branch has been pushed. An open PR is taken as it is: the branch is its head, wherever HEAD
   * here stands against it. A merged one is taken only when its head is in the row's own history,
   * since gh answers for the branch name, which a row landed and archived before may have carried
   * too; and never once a landing on the record names it, which is the row moved past its own
   * merge. A closed one is left: it changes nothing the box says, and the next PR on the branch
   * would be hidden behind it. A turn's end always asks; the ticks ask once per push and again
   * after the poll's interval, so a branch pushed for safekeeping costs one gh read a poll. */
  async discover(worktreeId: string, why: "turn" | "tick" | "poll"): Promise<void> {
    const { find, remoteHead, reaches } = this.d;
    if (!find || !remoteHead || !reaches) return;
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || this.finding.has(worktreeId)) return;
    if (wt.kind !== "worktree" || wt.pr) return;
    const repo = this.d.state.repo(wt.repoId);
    if (!repo || landPolicy(repo.config).land !== "pr") return;
    // the poll's answer reaches no one; the window coming back asks for itself
    if (why === "poll" && this.d.looking && !this.d.looking()) return;
    this.finding.add(worktreeId);
    try {
      const sha = await remoteHead(wt.path, wt.branch);
      if (!sha) {
        this.missed.delete(worktreeId);
        return;
      }
      const miss = this.missed.get(worktreeId);
      if (why !== "turn" && miss?.sha === sha && Date.now() - miss.at < (this.d.everyMs ?? POLL_MS)) return;
      const found = await find(repo.path, wt.branch);
      // removed, or a land press opened one while gh was answering
      const now = this.d.state.worktree(worktreeId);
      if (!now || now.pr) return;
      const taken = !!found && (now.lands ?? []).some((l) => l.pr === found.pr.number);
      const own =
        !!found &&
        !taken &&
        (found.pr.state === "open" ||
          (found.pr.state === "merged" && !!found.head && (await reaches(wt.path, found.head))));
      if (!found || !own) {
        this.missed.set(worktreeId, { sha, at: Date.now() });
        return;
      }
      this.missed.delete(worktreeId);
      log.info(worktreeId, `PR #${found.pr.number} for ${wt.branch} was opened outside toyon; taking it`);
      this.d.worktrees.setPr(worktreeId, found.pr);
      if (found.pr.state === "open") fireAndForget(worktreeId, this.readComments(worktreeId), "pr comments");
      if (found.pr.state === "merged") await this.d.worktrees.prMerged(worktreeId);
    } finally {
      this.finding.delete(worktreeId);
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
