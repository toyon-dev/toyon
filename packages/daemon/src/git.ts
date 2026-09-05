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
  // no trim: porcelain lines for unstaged changes start with a significant space
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return (r.stdout ?? "")
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({
      xy: line.slice(0, 2),
      path: line.slice(3).replace(/^"(.*)"$/, "$1").replace(/ -> .*$/, ""),
    }));
}

/** File content at merge-base with the default branch (empty string for new files). */
export function fileBefore(worktreePath: string, defaultBr: string, file: string): string {
  const base = git(worktreePath, "merge-base", "HEAD", defaultBr);
  const ref = base.ok && base.out ? base.out : "HEAD";
  const r = git(worktreePath, "show", `${ref}:${file}`);
  return r.ok ? r.out : "";
}

export interface ShipResult {
  ok: boolean;
  url?: string;
  message: string;
}

/** Commit everything, push, and open a PR (gh) or return the compare URL. */
export function shipWorktree(worktreePath: string, branch: string, defaultBr: string, title: string): ShipResult {
  const dirty = statusFiles(worktreePath).length > 0;
  if (dirty) {
    git(worktreePath, "add", "-A");
    const c = git(worktreePath, "commit", "-m", `orchardist: ${title}`);
    if (!c.ok && !c.err.includes("nothing to commit")) {
      return { ok: false, message: `commit failed: ${c.err}` };
    }
  }
  const ahead = git(worktreePath, "rev-list", "--count", `${defaultBr}..HEAD`);
  if (ahead.ok && ahead.out === "0") {
    return { ok: false, message: "nothing to ship — no commits ahead of " + defaultBr };
  }

  const remote = git(worktreePath, "remote", "get-url", "origin");
  if (!remote.ok) {
    return { ok: true, message: `committed locally on ${branch} — no 'origin' remote configured, nothing pushed` };
  }

  const push = git(worktreePath, "push", "-u", "origin", branch);
  if (!push.ok) return { ok: false, message: `push failed: ${push.err.slice(0, 300)}` };

  // gh if present -> real PR; else GitHub compare URL (user is logged in there)
  const gh = spawnSync("gh", ["pr", "create", "--fill", "--head", branch], {
    cwd: worktreePath, encoding: "utf8",
  });
  if (gh.status === 0) {
    const url = (gh.stdout ?? "").trim().split("\n").pop() ?? "";
    return { ok: true, url, message: `PR created: ${url}` };
  }
  const compare = compareUrl(remote.out, defaultBr, branch);
  return compare
    ? { ok: true, url: compare, message: "pushed — opening PR page" }
    : { ok: true, message: `pushed ${branch} to origin` };
}

function compareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const m =
    remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/) ??
    remoteUrl.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
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
