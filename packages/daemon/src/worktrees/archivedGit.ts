// An archived worktree's git, read from the refs that kept it. Its page shows the same changes
// panel and editor a live worktree has, and they get the same shapes back, but the directory and
// the branch are gone: the kept head, the snapshot of uncommitted work over it, and the tip of each
// landing are all there is to read.

import type { CommitEntry, GitFileStatus, LandMark } from "@toyon/shared";
import type { KeptState } from "../git/archive.ts";
import { git, gitRaw } from "../git/exec.ts";
import { fileAtCommit, logRange, commitFiles as readCommitFiles } from "../git/log.ts";
import { filesBetween } from "../git/status.ts";

export class ArchivedGit {
  constructor(
    private repoPath: string,
    private kept: KeptState,
    private lands: LandMark[],
    private defaultBr: string,
  ) {}

  /** Where the work that never landed starts: the kept head's fork from the default branch as it is
   * now. A branch that restarted from main after landing forks at its own head, so it has none. */
  private async tailBase(): Promise<string> {
    const r = await git(this.repoPath, "merge-base", this.kept.head, this.defaultBr);
    return r.ok && r.out ? r.out : this.kept.head;
  }

  /** the uncommitted work over the kept head, and what was committed but never reached main */
  async status(): Promise<{ files: GitFileStatus[]; committed: GitFileStatus[]; head: string }> {
    const base = await this.tailBase();
    const { head, snapshot } = this.kept;
    const [files, committed] = await Promise.all([
      snapshot ? filesBetween(this.repoPath, head, snapshot) : [],
      base === head ? [] : filesBetween(this.repoPath, base, head),
    ]);
    return { files, committed, head: snapshot ?? head };
  }

  /** The worktree's own commits, newest first: what never landed, then each landing's, the latest
   * landing first. A commit two ranges share (a squash leaves the originals off main, so the next
   * landing's range reaches back over them) is listed once, under the landing that carried it first. */
  async log(): Promise<CommitEntry[]> {
    const seen = new Set<string>();
    const unseen = (list: CommitEntry[]) => {
      const out = list.filter((c) => !seen.has(c.sha));
      for (const c of out) seen.add(c.sha);
      return out;
    };
    const landed: CommitEntry[][] = [];
    for (const land of this.lands) {
      const commits = unseen(await logRange(this.repoPath, land.base, land.tip));
      landed.push(commits.map((c) => ({ ...c, landedAt: land.at })));
    }
    const base = await this.tailBase();
    const tail = base === this.kept.head ? [] : unseen(await logRange(this.repoPath, base, this.kept.head));
    return [...tail, ...landed.reverse().flat()];
  }

  commitFiles(sha: string): Promise<GitFileStatus[]> {
    return readCommitFiles(this.repoPath, sha);
  }

  /** With `ref`, a file on either side of that commit. Without it, the file as the worktree left it,
   * uncommitted work included, against where its unlanded work forked: the diff a live worktree's
   * changes list opens. */
  async file(path: string, ref?: string): Promise<{ before: string; after: string }> {
    if (ref) return fileAtCommit(this.repoPath, ref, path);
    const base = await this.tailBase();
    // untrimmed, as the file is: a trim hides a final newline change
    const [before, after] = await Promise.all([
      gitRaw(this.repoPath, "show", `${base}:${path}`),
      gitRaw(this.repoPath, "show", `${this.kept.snapshot ?? this.kept.head}:${path}`),
    ]);
    return { before: before.ok ? before.out : "", after: after.ok ? after.out : "" };
  }
}
