// Landing operations: commit, merge into main, sync from main, push + PR. Each returns a
// ShipResult the UI shows as a toast; none commits on the user's behalf except commitWorktree.

import { GIT, git, NO_PROMPT, run } from "./exec.ts";
import { aheadBehind, behindUpstream, statusFiles } from "./status.ts";

export interface ShipResult {
  ok: boolean;
  url?: string;
  message: string;
  /** a real PR was created via gh (vs a compare-page URL) */
  prCreated?: boolean;
  /** the merge hit conflicts and was aborted; the one failure an agent can be asked to resolve */
  conflict?: true;
}

/** User-initiated commit of everything in the worktree, with the user's message. */
export async function commitWorktree(worktreePath: string, message: string): Promise<ShipResult> {
  if ((await statusFiles(worktreePath)).length === 0) return { ok: false, message: "nothing to commit" };
  await git(worktreePath, "add", "-A");
  const c = await git(worktreePath, "commit", "-m", message);
  if (!c.ok) return { ok: false, message: `commit failed: ${c.err.slice(0, 200)}` };
  return { ok: true, message: `committed: ${message}` };
}

/** Landing requires committed work — the tool never commits on the user's behalf. */
async function requireClean(worktreePath: string): Promise<ShipResult | null> {
  if ((await statusFiles(worktreePath)).length > 0) {
    return { ok: false, message: "uncommitted changes: commit them first (or ask the agent to finish up)" };
  }
  return null;
}

/** Merge the worktree's branch into the default branch in the main checkout. Local-only, no remote. */
export async function mergeToMain(
  worktreePath: string,
  branch: string,
  repoPath: string,
  defaultBr: string,
): Promise<ShipResult> {
  const cErr = await requireClean(worktreePath);
  if (cErr) return cErr;

  const { ahead } = await aheadBehind(worktreePath, defaultBr);
  if (ahead === 0) return { ok: false, message: `nothing to merge: no commits ahead of ${defaultBr}` };

  const current = await git(repoPath, "branch", "--show-current");
  if (current.out !== defaultBr) {
    return { ok: false, message: `main checkout is on '${current.out}', not ${defaultBr}; switch it first` };
  }
  // the merge writes into the main checkout, and someone may be editing there: git would carry
  // their edits through a clean merge and stop on a touched file, leaving them mid-merge
  if ((await statusFiles(repoPath)).length > 0) {
    return { ok: false, message: `${defaultBr} has uncommitted changes: commit or stash them there first` };
  }
  const m = await git(repoPath, "merge", "--no-edit", branch);
  if (!m.ok) return mergeFailure(repoPath, m, `merge conflicts with ${defaultBr}: sync this worktree first`);
  return { ok: true, message: `merged ${branch} into ${defaultBr}` };
}

/** Fast-forward the main checkout to its upstream ("pull"). Never a merge: a main that has
 * diverged from origin is a decision for a terminal, not a button. Fetches first, so the count
 * the button showed and the commits it brings are the same ones. */
export async function pullMain(repoPath: string, defaultBr: string): Promise<ShipResult> {
  const cErr = await requireClean(repoPath);
  if (cErr) return cErr;
  const current = await git(repoPath, "branch", "--show-current");
  if (current.out !== defaultBr) {
    return { ok: false, message: `main checkout is on '${current.out}', not ${defaultBr}; switch it first` };
  }
  const f = await run(GIT, ["fetch", "--quiet"], repoPath, NO_PROMPT);
  if (!f.ok) return { ok: false, message: `fetch failed: ${f.err.slice(0, 200)}` };
  const behind = await behindUpstream(repoPath);
  if (behind === null) return { ok: false, message: `${defaultBr} has no upstream to pull from` };
  if (behind === 0) return { ok: true, message: "already up to date with origin" };
  const m = await git(repoPath, "merge", "--ff-only", "@{upstream}");
  if (!m.ok) return { ok: false, message: `${defaultBr} has diverged from origin; reconcile it in a terminal` };
  return { ok: true, message: `pulled ${behind} commit(s) from origin` };
}

/** Merge main into the worktree ("sync") so it's up to date before landing. */
export async function syncFromMain(worktreePath: string, defaultBr: string): Promise<ShipResult> {
  const cErr = await requireClean(worktreePath);
  if (cErr) return cErr;
  const { behind } = await aheadBehind(worktreePath, defaultBr);
  if (behind === 0) return { ok: true, message: `already up to date with ${defaultBr}` };
  const m = await git(worktreePath, "merge", "--no-edit", defaultBr);
  if (!m.ok) {
    return mergeFailure(
      worktreePath,
      m,
      `sync conflicts with ${defaultBr}: ask the agent to merge ${defaultBr} and resolve them`,
    );
  }
  return { ok: true, message: `synced ${behind} commit(s) from ${defaultBr}` };
}

/** A conflict leaves a merge in progress that must be aborted; any other failure (dirty index,
 * unrelated histories, hook) has nothing to abort and deserves its own message. Both streams are
 * read: git reports a conflict on stdout, and reading stderr alone left every real conflict as an
 * empty "merge failed" with the merge still in progress. */
async function mergeFailure(
  cwd: string,
  m: { out: string; err: string },
  conflictMessage: string,
): Promise<ShipResult> {
  const said = [m.out, m.err].filter(Boolean).join("\n");
  const conflict = /CONFLICT|Automatic merge failed/.test(said);
  if (conflict) {
    await git(cwd, "merge", "--abort");
    return { ok: false, conflict: true, message: `${conflictMessage} (${said.slice(0, 200)})` };
  }
  return { ok: false, message: `merge failed: ${said.slice(0, 300)}` };
}

/** Commit everything, push, and open a PR (gh) or return the compare URL. */
export async function shipWorktree(worktreePath: string, branch: string, defaultBr: string): Promise<ShipResult> {
  const cErr = await requireClean(worktreePath);
  if (cErr) return cErr;
  const { ahead } = await aheadBehind(worktreePath, defaultBr);
  if (ahead === 0) return { ok: false, message: `nothing to ship: no commits ahead of ${defaultBr}` };

  const remote = await git(worktreePath, "remote", "get-url", "origin");
  if (!remote.ok) {
    return { ok: true, message: `committed locally on ${branch}: no 'origin' remote configured, nothing pushed` };
  }

  const push = await git(worktreePath, "push", "-u", "origin", branch);
  if (!push.ok) return { ok: false, message: `push failed: ${push.err.slice(0, 300)}` };

  // gh if present -> real PR; else GitHub compare URL (user is logged in there)
  const gh = await run("gh", ["pr", "create", "--fill", "--head", branch], worktreePath);
  if (gh.ok) {
    const url = gh.out.split("\n").pop() ?? "";
    return { ok: true, url, message: `PR created: ${url}`, prCreated: true };
  }
  if (gh.err.includes("already exists")) {
    return { ok: true, message: `pushed ${branch}: existing PR updated` };
  }
  const compare = compareUrl(remote.out, defaultBr, branch);
  return compare
    ? { ok: true, url: compare, message: "pushed: opening PR page" }
    : { ok: true, message: `pushed ${branch} to origin` };
}

function compareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const m =
    remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/) ?? remoteUrl.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}
