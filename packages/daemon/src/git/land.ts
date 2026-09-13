// Landing operations: commit, take main in, land locally by a method, push main, open or merge a
// PR. Each returns a ShipResult the UI shows as a toast. Toyon-owned branches are rebased onto main
// rather than merged with it, so a branch reads as if it started from today's main and every
// method after that is one command; a branch someone adopted keeps its history and is merged with.

import type { MergeMethod, PrState } from "@toyon/shared";
import { GIT, git, NO_PROMPT, run } from "./exec.ts";
import { gh, ghMethod, prNumberOf } from "./gh.ts";
import { aheadBehind, behindUpstream, statusFiles } from "./status.ts";

export interface ShipResult {
  ok: boolean;
  url?: string;
  message: string;
  /** the rebase or merge hit conflicts and was aborted; the one failure an agent can be asked to resolve */
  conflict?: true;
  /** the PR the route opened or found, for the record */
  pr?: Omit<PrState, "at">;
}

/** User-initiated commit of everything in the worktree, with the user's message. */
export async function commitWorktree(worktreePath: string, message: string): Promise<ShipResult> {
  if ((await statusFiles(worktreePath)).length === 0) return { ok: false, message: "nothing to commit" };
  await git(worktreePath, "add", "-A");
  const c = await git(worktreePath, "commit", "-m", message);
  if (!c.ok) return { ok: false, message: `commit failed: ${c.err.slice(0, 200)}` };
  return { ok: true, message: `committed: ${message}` };
}

/** Landing moves committed work; what is uncommitted is committed first or refused. */
async function requireClean(worktreePath: string): Promise<ShipResult | null> {
  if ((await statusFiles(worktreePath)).length > 0) {
    return { ok: false, message: "uncommitted changes: commit them first (or ask the agent to finish up)" };
  }
  return null;
}

/** the main checkout can take a merge: on its branch, and nothing uncommitted that a merge
 * would carry through or stop on */
async function requireMainReady(repoPath: string, defaultBr: string): Promise<ShipResult | null> {
  const current = await git(repoPath, "branch", "--show-current");
  if (current.out !== defaultBr) {
    return { ok: false, message: `main checkout is on '${current.out}', not ${defaultBr}; switch it first` };
  }
  if ((await statusFiles(repoPath)).length > 0) {
    return { ok: false, message: `${defaultBr} has uncommitted changes: commit or stash them there first` };
  }
  return null;
}

/** Take main into the branch: a rebase for a branch toyon owns, a merge for one it adopted. Both
 * leave the tree as it was on a conflict. */
export async function takeMainIn(worktreePath: string, defaultBr: string, own: boolean): Promise<ShipResult> {
  const cErr = await requireClean(worktreePath);
  if (cErr) return cErr;
  const { behind } = await aheadBehind(worktreePath, defaultBr);
  if (behind === 0) return { ok: true, message: `already up to date with ${defaultBr}` };
  if (own) {
    const r = await git(worktreePath, "rebase", defaultBr);
    if (!r.ok) {
      await git(worktreePath, "rebase", "--abort");
      const said = [r.out, r.err].filter(Boolean).join("\n");
      return {
        ok: false,
        conflict: true,
        message: `rebase onto ${defaultBr} conflicts: ask the agent to bring ${defaultBr} in and resolve them (${said.slice(0, 200)})`,
      };
    }
    return { ok: true, message: `rebased onto ${defaultBr}, ${behind} commit(s) behind before` };
  }
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

/** Land the branch on main in the main checkout by the method: a merge commit, one squashed
 * commit carrying `message`, or a fast-forward. The branch is expected to hold main already
 * (takeMainIn), so the fast-forward is exact and the merge commit records only the landing. */
export async function landLocally(
  worktreePath: string,
  branch: string,
  repoPath: string,
  defaultBr: string,
  method: MergeMethod,
  message: string,
): Promise<ShipResult> {
  const cErr = await requireClean(worktreePath);
  if (cErr) return cErr;
  const { ahead } = await aheadBehind(worktreePath, defaultBr);
  if (ahead === 0) return { ok: false, message: `nothing to merge: no commits ahead of ${defaultBr}` };
  const mErr = await requireMainReady(repoPath, defaultBr);
  if (mErr) return mErr;
  if (method === "rebase") {
    const ff = await git(repoPath, "merge", "--ff-only", branch);
    if (!ff.ok)
      return { ok: false, message: `${branch} is not a fast-forward of ${defaultBr}: take ${defaultBr} in first` };
    return { ok: true, message: `${defaultBr} moved onto ${branch}` };
  }
  if (method === "squash") {
    const s = await git(repoPath, "merge", "--squash", branch);
    if (!s.ok) {
      await git(repoPath, "reset", "--hard", "HEAD");
      return mergeFailure(repoPath, s, `merge conflicts with ${defaultBr}: take ${defaultBr} in first`);
    }
    const c = await git(repoPath, "commit", "-m", message);
    if (!c.ok) {
      await git(repoPath, "reset", "--hard", "HEAD");
      return { ok: false, message: `squash commit failed: ${c.err.slice(0, 200)}` };
    }
    return { ok: true, message: `squashed ${branch} onto ${defaultBr}` };
  }
  const m = await git(repoPath, "merge", "--no-ff", "--no-edit", branch);
  if (!m.ok) return mergeFailure(repoPath, m, `merge conflicts with ${defaultBr}: take ${defaultBr} in first`);
  return { ok: true, message: `merged ${branch} into ${defaultBr}` };
}

/** the one commit's own message when the branch holds one, else what the caller suggests, else
 * the subjects as a list: what a squash lands under */
export async function squashMessage(worktreePath: string, defaultBr: string, suggested?: string): Promise<string> {
  const n = await git(worktreePath, "rev-list", "--count", `${defaultBr}..HEAD`);
  if (n.out === "1") {
    const one = await git(worktreePath, "log", "-1", "--format=%B");
    if (one.ok && one.out.trim()) return one.out.trim();
  }
  if (suggested) return suggested;
  const subjects = await git(worktreePath, "log", "--format=%s", `${defaultBr}..HEAD`);
  return subjects.out.trim() || "land";
}

/** Fast-forward the main checkout to its upstream ("pull"). Never a merge: a main that has
 * diverged from origin is a decision for a terminal, not a button. Fetches first, so the count
 * the button showed and the commits it brings are the same ones. */
export async function pullMain(repoPath: string, defaultBr: string): Promise<ShipResult> {
  const cErr = await requireClean(repoPath);
  if (cErr) return cErr;
  return fastForwardMain(repoPath, defaultBr);
}

/** The same fast-forward without the clean check: after a PR merges, main here should move even
 * with unrelated edits in the checkout, and git itself refuses when an edit would be overwritten */
export async function fastForwardMain(repoPath: string, defaultBr: string): Promise<ShipResult> {
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
  if (!m.ok) {
    const clobber = /overwritten by merge|would be overwritten/.test(`${m.out}\n${m.err}`);
    return {
      ok: false,
      message: clobber
        ? `${defaultBr} here has edits the pull would overwrite; commit or stash them first`
        : `${defaultBr} has diverged from origin; reconcile it in a terminal`,
    };
  }
  return { ok: true, message: `pulled ${behind} commit(s) from origin` };
}

/** push main to origin after a local land; a rejection means origin moved in between */
export async function pushMain(repoPath: string, defaultBr: string): Promise<ShipResult> {
  const p = await run(GIT, ["push", "origin", defaultBr], repoPath, NO_PROMPT);
  if (p.ok) return { ok: true, message: `pushed ${defaultBr} to origin` };
  const moved = /rejected|fetch first|non-fast-forward/.test(p.err);
  return {
    ok: false,
    message: moved
      ? `${defaultBr} on origin moved; pull ${defaultBr} and land again`
      : `push failed: ${p.err.slice(0, 300)}`,
  };
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

export interface OpenPr {
  worktreePath: string;
  branch: string;
  defaultBr: string;
  /** the PR's title and body: the suggested commit message when there is one */
  subject?: string;
  body?: string;
  automerge: boolean;
  /** the method auto-merge uses; unset follows the repo's allowed methods */
  method?: MergeMethod;
}

/** Push the branch and open a PR through gh, or hand back the compare URL where gh is not
 * around. A branch already on origin from an earlier push is force-pushed with lease, since it
 * was rebased since; a PR that already exists is found rather than made twice. */
export async function openPr(o: OpenPr): Promise<ShipResult> {
  const cErr = await requireClean(o.worktreePath);
  if (cErr) return cErr;
  const { ahead } = await aheadBehind(o.worktreePath, o.defaultBr);
  if (ahead === 0) return { ok: false, message: `nothing to ship: no commits ahead of ${o.defaultBr}` };
  const remote = await git(o.worktreePath, "remote", "get-url", "origin");
  if (!remote.ok) return { ok: false, message: "no 'origin' remote: add one, or land by merging here" };

  const push = await run(GIT, ["push", "-u", "--force-with-lease", "origin", o.branch], o.worktreePath, NO_PROMPT);
  if (!push.ok) return { ok: false, message: `push failed: ${push.err.slice(0, 300)}` };

  const titled = o.subject ? ["--title", o.subject, "--body", o.body ?? ""] : ["--fill"];
  const created = await gh(["pr", "create", "--head", o.branch, "--base", o.defaultBr, ...titled], o.worktreePath);
  let url: string | null = null;
  if (created.ok) url = created.out.split("\n").pop()?.trim() || null;
  else if (/already exists/.test(created.err)) {
    const found = await gh(["pr", "view", o.branch, "--json", "url", "--jq", ".url"], o.worktreePath, 20_000);
    if (found.ok) url = found.out.trim() || null;
  } else if (
    /command not found|No such file|ENOENT|not logged in|gh auth login/i.test(`${created.err}\n${created.exit}`)
  ) {
    const compare = compareUrl(remote.out, o.defaultBr, o.branch);
    return compare
      ? { ok: true, url: compare, message: `pushed ${o.branch}; gh is not set up here, so the PR is yours to open` }
      : { ok: true, message: `pushed ${o.branch} to origin; gh is not set up here, so the PR is yours to open` };
  } else return { ok: false, message: `gh pr create failed: ${created.err.slice(0, 300)}` };

  const number = url ? prNumberOf(url) : null;
  if (!url || number === null) return { ok: true, message: `pushed ${o.branch}; PR opened but its URL was not read` };

  let note = "";
  if (o.automerge) {
    const method = await ghMethod(o.worktreePath, o.method);
    const auto = method ? await gh(["pr", "merge", String(number), "--auto", `--${method}`], o.worktreePath) : null;
    note = auto?.ok ? "; GitHub merges it when its rules allow" : "; auto-merge could not be turned on";
  }
  return {
    ok: true,
    url,
    message: `PR #${number} opened${note}`,
    pr: { number, url, state: "open", ...(o.automerge ? { automerge: true } : {}) },
  };
}

/** merge an open PR through gh, by the method toyon.json asks for or the repo allows */
export async function mergePr(worktreePath: string, number: number, wanted?: MergeMethod): Promise<ShipResult> {
  const method = await ghMethod(worktreePath, wanted);
  if (!method) return { ok: false, message: "the repo allows no merge method gh can use" };
  const r = await gh(["pr", "merge", String(number), `--${method}`], worktreePath);
  if (!r.ok) return { ok: false, message: `gh pr merge failed: ${r.err.slice(0, 300)}` };
  return { ok: true, message: `PR #${number} merged` };
}

function compareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const m =
    remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/) ?? remoteUrl.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}
