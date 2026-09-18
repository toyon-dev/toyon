// A removed worktree's git state, kept under a ref so it can be put back. One ref per worktree: a
// commit of its uncommitted work whose parent is HEAD when there was any, else HEAD itself, so the
// ref alone keeps both reachable and gc collects neither.

import { rmSync } from "node:fs";
import { GIT, git, gitOrThrow, gitRaw, run } from "./exec.ts";
import { parsePorcelain } from "./status.ts";

/** outside refs/heads, so no branch list, ref picker or push ever shows it */
export const archiveRef = (worktreeId: string) => `refs/toyon/archive/${worktreeId}`;

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
        "user.name=toyon",
        "-c",
        "user.email=toyon@localhost",
        "commit-tree",
        tree.out,
        "-p",
        head,
        "-m",
        "toyon: uncommitted work",
      ],
      wtPath,
    );
    return commit.ok ? commit.out : null;
  } finally {
    rmSync(indexFile, { force: true });
  }
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

/** Drop every landing ref a worktree holds. Best effort: a ref left behind only keeps commits alive. */
export async function dropLandRefs(repoPath: string, worktreeId: string): Promise<void> {
  const r = await git(repoPath, "for-each-ref", "--format=%(refname)", `refs/toyon/lands/${worktreeId}/`);
  if (!r.ok || !r.out) return;
  for (const ref of r.out.split("\n").filter(Boolean)) await git(repoPath, "update-ref", "-d", ref);
}
