// Branch history for the changes panel's history tab: the commit list, one commit's files, and
// one file's content on either side of a commit. Read-only; nothing here writes a ref.

import type { CommitEntry, GitFileStatus } from "@toyon/shared";
import { git, gitRaw } from "./exec.ts";
import { parseNumstat } from "./status.ts";

/** How far back the history tab reads. Deep enough to cover a worktree's own work and the main
 * history around it; short enough that the list stays one frame's worth of rows to build. */
export const LOG_LIMIT = 200;

/** NUL between fields, record separator between commits: a subject cannot contain either, and
 * neither can an author name, so the parse needs no escaping rules. */
const FORMAT = "--format=%H%x00%h%x00%an%x00%at%x00%s%x1e";

/** The worktree's history, newest first, with the commits ahead of the default branch flagged. */
export async function logCommits(worktreePath: string, defaultBr: string, limit = LOG_LIMIT): Promise<CommitEntry[]> {
  const [r, ahead] = await Promise.all([
    git(worktreePath, "log", `-n${limit}`, FORMAT),
    aheadShas(worktreePath, defaultBr),
  ]);
  // an unborn branch has no HEAD to log: an empty history, not an error the person should read
  return r.ok && r.out ? parseLog(r.out, (sha) => ahead.has(sha)) : [];
}

/** The commits in `from..to`, newest first, every one flagged as the worktree's own: an archived
 * worktree's history is read from the refs that kept it, with no branch left to count against. */
export async function logRange(cwd: string, from: string, to: string, limit = LOG_LIMIT): Promise<CommitEntry[]> {
  const r = await git(cwd, "log", `-n${limit}`, FORMAT, `${from}..${to}`);
  return r.ok && r.out ? parseLog(r.out, () => true) : [];
}

function parseLog(out: string, ahead: (sha: string) => boolean): CommitEntry[] {
  const commits: CommitEntry[] = [];
  for (const rec of out.split("\x1e")) {
    const [sha, short, author, at, subject] = rec.trim().split("\0");
    if (!sha || !short || subject === undefined) continue;
    commits.push({
      sha,
      short,
      subject,
      author: author ?? "",
      at: Number(at) * 1000 || 0,
      ahead: ahead(sha),
    });
  }
  return commits;
}

/** The commits on this branch that the default branch does not have. Empty on the main worktree,
 * where HEAD is the default branch. */
async function aheadShas(worktreePath: string, defaultBr: string): Promise<Set<string>> {
  const r = await git(worktreePath, "rev-list", `${defaultBr}..HEAD`);
  if (!r.ok || !r.out) return new Set();
  return new Set(r.out.split("\n").filter(Boolean));
}

/** The files one commit touched, with its +/- counts. A merge reports its diff against the first
 * parent, which is the change the merge actually brought in; without that git prints nothing. */
export async function commitFiles(worktreePath: string, sha: string): Promise<GitFileStatus[]> {
  const [names, nums] = await Promise.all([
    git(worktreePath, "show", "--first-parent", "--name-status", "--no-renames", "--format=", sha),
    git(worktreePath, "show", "--first-parent", "--numstat", "--no-renames", "--format=", sha),
  ]);
  if (!names.ok || !names.out) return [];
  const counts = nums.ok ? parseNumstat(nums.out) : new Map();
  return names.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      const path = (rest[rest.length - 1] ?? "").replace(/^"(.*)"$/, "$1");
      // one letter, in the X column, so the row draws the same as an uncommitted one
      return { xy: `${(status ?? "M").slice(0, 1)} `, path, ...(counts.get(path) ?? {}) };
    })
    .filter((f) => f.path);
}

/** A file as the commit left it, and as its first parent had it. Both empty for a path the commit
 * did not touch, and `before` empty for a file the commit added (or for a root commit). */
export async function fileAtCommit(
  worktreePath: string,
  sha: string,
  file: string,
): Promise<{ before: string; after: string }> {
  // untrimmed, as the file is: a trim eats a first line's indent and hides a final newline change
  const [before, after] = await Promise.all([
    gitRaw(worktreePath, "show", `${sha}^:${file}`),
    gitRaw(worktreePath, "show", `${sha}:${file}`),
  ]);
  return { before: before.ok ? before.out : "", after: after.ok ? after.out : "" };
}
