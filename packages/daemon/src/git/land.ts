// Landing operations: commit, merge into main, sync from main, push + PR. Each returns a
// ShipResult the UI shows as a toast; none commits on the user's behalf except commitWorktree.

import { spawnSync } from "node:child_process";
import { git } from "./exec.ts";
import { aheadBehind, statusFiles } from "./status.ts";

export interface ShipResult {
  ok: boolean;
  url?: string;
  message: string;
  /** a real PR was created via gh (vs a compare-page URL) */
  prCreated?: boolean;
}

/** User-initiated commit of everything in the worktree, with the user's message. */
export function commitWorktree(worktreePath: string, message: string): ShipResult {
  if (statusFiles(worktreePath).length === 0) return { ok: false, message: "nothing to commit" };
  git(worktreePath, "add", "-A");
  const c = git(worktreePath, "commit", "-m", message);
  if (!c.ok) return { ok: false, message: `commit failed: ${c.err.slice(0, 200)}` };
  return { ok: true, message: `committed: ${message}` };
}

/** Landing requires committed work — the tool never commits on the user's behalf. */
function requireClean(worktreePath: string): ShipResult | null {
  if (statusFiles(worktreePath).length > 0) {
    return { ok: false, message: "uncommitted changes — commit them first (or ask the agent to finish up)" };
  }
  return null;
}

/** Merge the worktree's branch into the default branch in the main checkout. Local-only, no remote. */
export function mergeToMain(
  worktreePath: string,
  branch: string,
  repoPath: string,
  defaultBr: string,
  _title: string,
): ShipResult {
  const cErr = requireClean(worktreePath);
  if (cErr) return cErr;

  const { ahead } = aheadBehind(worktreePath, defaultBr);
  if (ahead === 0) return { ok: false, message: `nothing to merge — no commits ahead of ${defaultBr}` };

  const current = git(repoPath, "branch", "--show-current");
  if (current.out !== defaultBr) {
    return { ok: false, message: `main checkout is on '${current.out}', not ${defaultBr} — switch it first` };
  }
  const m = git(repoPath, "merge", "--no-edit", branch);
  if (!m.ok) {
    git(repoPath, "merge", "--abort");
    return {
      ok: false,
      message: `merge conflicts with ${defaultBr} — sync this worktree first (${m.err.slice(0, 200)})`,
    };
  }
  return { ok: true, message: `merged ${branch} into ${defaultBr}` };
}

/** Merge main into the worktree ("sync") so it's up to date before landing. */
export function syncFromMain(worktreePath: string, defaultBr: string): ShipResult {
  const cErr = requireClean(worktreePath);
  if (cErr) return cErr;
  const { behind } = aheadBehind(worktreePath, defaultBr);
  if (behind === 0) return { ok: true, message: `already up to date with ${defaultBr}` };
  const m = git(worktreePath, "merge", "--no-edit", defaultBr);
  if (!m.ok) {
    git(worktreePath, "merge", "--abort");
    return {
      ok: false,
      message: `sync conflicts with ${defaultBr} — ask the agent to merge ${defaultBr} and resolve them`,
    };
  }
  return { ok: true, message: `synced ${behind} commit(s) from ${defaultBr}` };
}

/** Commit everything, push, and open a PR (gh) or return the compare URL. */
export function shipWorktree(worktreePath: string, branch: string, defaultBr: string, _title: string): ShipResult {
  const cErr = requireClean(worktreePath);
  if (cErr) return cErr;
  const ahead = git(worktreePath, "rev-list", "--count", `${defaultBr}..HEAD`);
  if (ahead.ok && ahead.out === "0") {
    return { ok: false, message: `nothing to ship — no commits ahead of ${defaultBr}` };
  }

  const remote = git(worktreePath, "remote", "get-url", "origin");
  if (!remote.ok) {
    return { ok: true, message: `committed locally on ${branch} — no 'origin' remote configured, nothing pushed` };
  }

  const push = git(worktreePath, "push", "-u", "origin", branch);
  if (!push.ok) return { ok: false, message: `push failed: ${push.err.slice(0, 300)}` };

  // gh if present -> real PR; else GitHub compare URL (user is logged in there)
  const gh = spawnSync("gh", ["pr", "create", "--fill", "--head", branch], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (gh.status === 0) {
    const url = (gh.stdout ?? "").trim().split("\n").pop() ?? "";
    return { ok: true, url, message: `PR created: ${url}`, prCreated: true };
  }
  if ((gh.stderr ?? "").includes("already exists")) {
    return { ok: true, message: `pushed ${branch} — existing PR updated` };
  }
  const compare = compareUrl(remote.out, defaultBr, branch);
  return compare
    ? { ok: true, url: compare, message: "pushed — opening PR page" }
    : { ok: true, message: `pushed ${branch} to origin` };
}

function compareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const m =
    remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/) ?? remoteUrl.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}
