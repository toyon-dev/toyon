import { spawnSync } from "node:child_process";
import type { GitFileStatus } from "@orchardist/shared";

export function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function gitOrThrow(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
  return r.out;
}

export function isGitRepo(path: string): boolean {
  return git(path, "rev-parse", "--is-inside-work-tree").out === "true";
}

export function repoRoot(path: string): string {
  return gitOrThrow(path, "rev-parse", "--show-toplevel");
}

export function defaultBranch(path: string): string {
  const head = git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (head.ok && head.out) return head.out.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (git(path, "show-ref", "--verify", `refs/heads/${b}`).ok) return b;
  }
  return gitOrThrow(path, "branch", "--show-current");
}

export function statusFiles(worktreePath: string): GitFileStatus[] {
  const r = gitOrThrow(worktreePath, "status", "--porcelain");
  if (!r) return [];
  return r.split("\n").map((line) => ({
    xy: line.slice(0, 2),
    path: line.slice(3).replace(/^"(.*)"$/, "$1"),
  }));
}

/** File content at merge-base with the default branch (empty string for new files). */
export function fileBefore(worktreePath: string, defaultBr: string, file: string): string {
  const base = git(worktreePath, "merge-base", "HEAD", defaultBr);
  const ref = base.ok && base.out ? base.out : "HEAD";
  const r = git(worktreePath, "show", `${ref}:${file}`);
  return r.ok ? r.out : "";
}

// Per-repo mutex for daemon-initiated mutations of shared git state
// (branch create/delete, worktree add/remove, spare refresh). Agent commits in
// their own worktrees need no coordination (separate indexes).
const locks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(repoPath, next.catch(() => {}));
  return next;
}
