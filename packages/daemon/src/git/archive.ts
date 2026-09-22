// A removed worktree's git state, kept under a ref so it can be put back. One ref per worktree: a
// commit of its uncommitted work whose parent is HEAD when there was any, else HEAD itself, so the
// ref alone keeps both reachable and gc collects neither.

import { rmSync } from "node:fs";
import { GIT, git, gitOrThrow, gitRaw, run } from "./exec.ts";
import { parsePorcelain } from "./status.ts";

/** outside refs/heads, so no branch list, ref picker or push ever shows it */
export const archiveRef = (worktreeId: string) => `refs/toyon/archive/${worktreeId}`;

/** the subject and author of a snapshot commit: what tells one apart from a commit the person made */
const SNAPSHOT_SUBJECT = "toyon: uncommitted work";
const SNAPSHOT_AUTHOR = "toyon";

export interface KeptState {
  /** the commit the worktree was on */
  head: string;
  /** its uncommitted work as a commit over head: untracked files included, ignored ones not */
  snapshot?: string;
  /** how many files that work touched. Counted here because it is the last moment the directory
   * exists, and a row that lists the archive should not open a diff to say a number. */
  dirty?: number;
  /** there was uncommitted work and it could not be kept */
  lost?: boolean;
}

/** Point `ref` at a worktree's state as it stands. `indexFile` is a scratch path: the snapshot is
 * staged into an index of its own, so the worktree's staging area is never touched. Null when there
 * is no HEAD to keep or the ref cannot be written. */
export async function keepState(
  repoPath: string,
  wtPath: string,
  ref: string,
  indexFile: string,
): Promise<KeptState | null> {
  const head = await git(wtPath, "rev-parse", "--verify", "HEAD");
  if (!head.ok) return null;
  // -uall, so the count is the one the rail showed this worktree while it was live
  const status = await gitRaw(wtPath, "status", "--porcelain", "-uall");
  // a status that failed is treated as dirty: a snapshot of a clean tree costs one commit object
  const files = status.ok ? parsePorcelain(status.out).length : null;
  const dirty = files === null || files > 0;
  const snapshot = dirty ? await snapshotCommit(wtPath, head.out, indexFile) : null;
  if (!(await git(repoPath, "update-ref", ref, snapshot ?? head.out)).ok) return null;
  return {
    head: head.out,
    ...(snapshot ? { snapshot, ...(files ? { dirty: files } : {}) } : dirty ? { lost: true } : {}),
  };
}

async function snapshotCommit(wtPath: string, head: string, indexFile: string): Promise<string | null> {
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    if (!(await run(GIT, ["read-tree", head], wtPath, env)).ok) return null;
    if (!(await run(GIT, ["add", "-A"], wtPath, env)).ok) return null;
    const tree = await run(GIT, ["write-tree"], wtPath, env);
    if (!tree.ok) return null;
    // toyon's own identity: the commit is its bookkeeping and is never pushed, and a repo with no
    // user configured would otherwise refuse to make it
    const commit = await run(
      GIT,
      [
        "-c",
        `user.name=${SNAPSHOT_AUTHOR}`,
        "-c",
        "user.email=toyon@localhost",
        "commit-tree",
        tree.out,
        "-p",
        head,
        "-m",
        SNAPSHOT_SUBJECT,
      ],
      wtPath,
    );
    return commit.ok ? commit.out : null;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** The state `ref` already keeps, read back from the commit it names: the head, and the snapshot
 * over it when that commit is one. For an archive whose earlier try wrote the ref and then lost the
 * directory, so nothing can be read from there again. Null when the ref names nothing. */
export async function keptAt(repoPath: string, ref: string): Promise<KeptState | null> {
  const r = await git(repoPath, "log", "-1", "--format=%H%n%P%n%an%n%s", ref);
  if (!r.ok) return null;
  const [commit, parents, author, subject] = r.out.split("\n");
  if (!commit) return null;
  const snapshot = subject === SNAPSHOT_SUBJECT && author === SNAPSHOT_AUTHOR && parents && !parents.includes(" ");
  if (!snapshot) return { head: commit };
  const files = await git(repoPath, "diff", "--name-only", parents, commit);
  const dirty = files.ok ? files.out.split("\n").filter(Boolean).length : 0;
  return { head: parents, snapshot: commit, ...(dirty ? { dirty } : {}) };
}

/** Check a kept state out at `wtPath`: on a new branch at the kept head, or on an existing branch
 * as it stands, then the uncommitted work over it, unstaged. */
export async function checkOutKept(
  repoPath: string,
  wtPath: string,
  kept: KeptState,
  branch: { name: string; create: boolean },
): Promise<void> {
  // a directory deleted by hand stays registered, and git refuses its branch until it is pruned
  await git(repoPath, "worktree", "prune");
  if (branch.create) await gitOrThrow(repoPath, "worktree", "add", "-b", branch.name, wtPath, kept.head);
  else await gitOrThrow(repoPath, "worktree", "add", wtPath, branch.name);
  if (kept.snapshot) await gitOrThrow(wtPath, "restore", `--source=${kept.snapshot}`, "--worktree", "--", ".");
}

/** the commit a ref names, or null when there is none */
export async function commitOf(repoPath: string, ref: string): Promise<string | null> {
  const r = await git(repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return r.ok ? r.out : null;
}

/** the commits a landing carries: from where the branch sits on the default branch to its tip */
export interface LandingRange {
  base: string;
  tip: string;
}

/** One landing's tip, kept past the branch restarting from main, and past a squash that never puts
 * these commits on main at all. */
export const landRef = (worktreeId: string, n: number) => `refs/toyon/lands/${worktreeId}/${n}`;

/** The branch about to land, read before anything moves: null when it holds nothing main lacks. */
export async function landingMark(worktreePath: string, defaultBr: string): Promise<LandingRange | null> {
  const [tip, base] = await Promise.all([
    git(worktreePath, "rev-parse", "HEAD"),
    git(worktreePath, "merge-base", "HEAD", defaultBr),
  ]);
  if (!tip.ok || !base.ok || !tip.out || tip.out === base.out) return null;
  return { base: base.out, tip: tip.out };
}

/** A landing git did without toyon: the agent, or a hand in the terminal, put the branch's commits
 * on main. Asked of a branch that is clean and level with main, so the only question left is
 * whether it ever had commits of its own, which its reflog says: entries a commit wrote since the
 * branch was created or last reset. Commits reset away by hand leave a newer reset entry, so they
 * are not a landing. The range is the branch's own commits by first parent, which a rebase keeps
 * together, from `since` (the tip of its last landing, when the branch went on from it: a reset
 * onto a main the branch already equals writes no entry to count from) or else from where the
 * count runs out. Null with nothing new to land, or history too short to walk. */
export async function handLanding(
  worktreePath: string,
  branch: string,
  defaultBr: string,
  since?: string,
): Promise<LandingRange | null> {
  const log = await git(worktreePath, "reflog", "show", "--format=%H %gs", branch);
  if (!log.ok || !log.out) return null;
  let own = 0;
  for (const line of log.out.split("\n")) {
    const subject = line.slice(line.indexOf(" ") + 1);
    // newest first: where the branch last stood on main ends the count
    if (/^(reset|branch):/.test(subject)) break;
    // an amend replaces the commit under it; a merge is one commit by first parent
    if (/^(commit|cherry-pick)\b/.test(subject) && !subject.startsWith("commit (amend)")) own++;
  }
  if (own === 0) return null;
  const [tip, walked, onMain, fromSince] = await Promise.all([
    git(worktreePath, "rev-parse", "HEAD"),
    git(worktreePath, "rev-parse", `HEAD~${own}`),
    git(worktreePath, "merge-base", "--is-ancestor", "HEAD", defaultBr),
    since ? git(worktreePath, "merge-base", "--is-ancestor", since, "HEAD") : null,
  ]);
  if (!tip.ok || !onMain.ok || !walked.ok) return null;
  const base = fromSince?.ok && since ? since : walked.out;
  return base === tip.out ? null : { base, tip: tip.out };
}

/** Drop every landing ref a worktree holds. Best effort: a ref left behind only keeps commits alive. */
export async function dropLandRefs(repoPath: string, worktreeId: string): Promise<void> {
  const r = await git(repoPath, "for-each-ref", "--format=%(refname)", `refs/toyon/lands/${worktreeId}/`);
  if (!r.ok || !r.out) return;
  for (const ref of r.out.split("\n").filter(Boolean)) await git(repoPath, "update-ref", "-d", ref);
}
