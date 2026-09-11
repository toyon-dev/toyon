// A removed worktree's git state, kept under a ref so it can be put back. One ref per worktree: a
// commit of its uncommitted work whose parent is HEAD when there was any, else HEAD itself, so the
// ref alone keeps both reachable and gc collects neither.

import { rmSync } from "node:fs";
import { GIT, git, gitOrThrow, run } from "./exec.ts";

/** outside refs/heads, so no branch list, ref picker or push ever shows it */
export const archiveRef = (worktreeId: string) => `refs/toyon/archive/${worktreeId}`;

export interface KeptState {
  /** the commit the worktree was on */
  head: string;
  /** its uncommitted work as a commit over head: untracked files included, ignored ones not */
  snapshot?: string;
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
  const status = await git(wtPath, "status", "--porcelain");
  // a status that failed is treated as dirty: a snapshot of a clean tree costs one commit object
  const dirty = !status.ok || status.out !== "";
  const snapshot = dirty ? await snapshotCommit(wtPath, head.out, indexFile) : null;
  if (!(await git(repoPath, "update-ref", ref, snapshot ?? head.out)).ok) return null;
  return { head: head.out, ...(snapshot ? { snapshot } : dirty ? { lost: true } : {}) };
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
