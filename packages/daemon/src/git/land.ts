// Landing operations: commit, take main in, land locally by a method, build and push a landing
// onto origin's main, open or merge a PR. Each returns a ShipResult the shell reads out where the work is. Toyon-owned branches are rebased onto main
// rather than merged with it, so a branch reads as if it started from today's main and every
// method after that is one command; a branch someone adopted keeps its history and is merged with.

import {
  baseIsRemote,
  baseOf,
  describeDuration,
  type MergeMethod,
  type PrState,
  type RepoInfo,
  type TrunkStatus,
} from "@toyon/shared";
import { GIT, git, NO_PROMPT, run, runWatched, type Watched } from "./exec.ts";
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

/** no step of a landing runs longer than this: a hook that waits on something nobody can answer
 * would otherwise hold the press, and the repo lock with it, forever. A commit runs under the
 * settings' own ceiling instead (`timeouts.commit`), since its pre-commit hook is where a suite
 * that takes twenty minutes legitimately runs. */
export const STEP_TIMEOUT_MS = 10 * 60_000;

/** how one step is run beyond the command: its ceiling, and what the wait on it may report */
export interface StepOpts {
  timeoutMs?: number;
  onSpawn?: (pid: number, kill: () => void) => void;
  onHook?: (hook: string | undefined) => void;
}

/** what a step left, and whether what it printed is on the chat already, so the message can
 * point there rather than quote it */
export type StepResult = Watched & { shown?: boolean };

/** How a landing's steps are run. `step` names the one starting, for the person waiting on the
 * press; `git` runs one git command with its output watched, so a hook's minutes read live and
 * what it printed is kept whole when it refuses. The daemon passes the watch that writes the
 * worktree's transcript; a caller with no one watching (a pull on main, a test) runs UNWATCHED. */
export interface LandWatch {
  step(name: string): void;
  git(cwd: string, args: string[]): Promise<StepResult>;
}

/** one git step, run to completion, to the ceiling, or to a stop pressed on its row */
export const stepRun = (
  cwd: string,
  args: string[],
  onText?: (text: string) => void,
  signal?: AbortSignal,
  opts: StepOpts = {},
): Promise<Watched> =>
  runWatched(GIT, args, cwd, { env: NO_PROMPT, onText, signal, ...opts, timeoutMs: opts.timeoutMs ?? STEP_TIMEOUT_MS });

export const UNWATCHED: LandWatch = {
  step() {},
  git: (cwd, args) => stepRun(cwd, args),
};

/** the message for a step git refused: where its output went, or its first words when no
 * transcript took them. A step killed at the ceiling says so, since its output ends mid-run. */
export function refused(what: string, r: StepResult, n = 200): string {
  if (r.exit === "timeout") {
    const after = describeDuration(r.ceilingMs ?? STEP_TIMEOUT_MS);
    return `${what} gave up after ${after}${r.shown ? "; what it printed is on the chat" : ""}`;
  }
  return `${what}: ${r.shown ? "what git and its hooks printed is on the chat" : r.err.slice(0, n)}`;
}

/** User-initiated commit of everything in the worktree, with the user's message. */
export async function commitWorktree(
  worktreePath: string,
  message: string,
  w: LandWatch = UNWATCHED,
): Promise<ShipResult> {
  if ((await statusFiles(worktreePath)).length === 0) return { ok: false, message: "nothing to commit" };
  await git(worktreePath, "add", "-A");
  w.step("committing");
  const c = await w.git(worktreePath, ["commit", "-m", message]);
  if (!c.ok) return { ok: false, message: refused("commit refused", c) };
  return { ok: true, message: `committed: ${message}` };
}

/** Landing moves committed work; what is uncommitted is committed first or refused. */
async function requireClean(worktreePath: string): Promise<ShipResult | null> {
  if ((await statusFiles(worktreePath)).length > 0) {
    return { ok: false, message: "uncommitted changes: commit them first (or ask the agent to finish up)" };
  }
  return null;
}

/** The files git named when it refused to move a checkout over them. A merge or fast-forward
 * checks every file it would rewrite against the working tree before touching any, and aborts
 * listing the ones in the way under one of two headers (tracked edits, untracked files); what is
 * uncommitted elsewhere in the tree is no concern of its and stays as it was. Empty when the
 * refusal was about something else. */
export function overwritten(text: string): string[] {
  const files: string[] = [];
  let listing = false;
  for (const line of text.split("\n")) {
    if (/would be overwritten by (merge|checkout):\s*$/.test(line)) {
      listing = true;
    } else if (listing && line.startsWith("\t")) {
      files.push(line.trim());
    } else {
      listing = false;
    }
  }
  return files;
}

/** why a landing or pull stood: the files on main in its way, named so the person knows which of
 * main's uncommitted files to commit or stash, rather than told to clear all of them */
function inTheWay(defaultBr: string, what: string, files: string[]): string {
  const shown = files.length > 3 ? `${files.slice(0, 3).join(", ")} and ${files.length - 3} more` : files.join(", ");
  return `${defaultBr} has uncommitted files the ${what} would overwrite (${shown}): commit or stash them there first`;
}

/** The main checkout can take the landing: on its branch, and clean when the method needs it.
 * A fast-forward or merge refuses on its own the one thing that matters, an uncommitted file it
 * would rewrite, and leaves the rest alone, so an edit that has nothing to do with the branch
 * (a version bump waiting on a release, a local config tweak) blocks nothing. A squash cannot be
 * given that: its recovery from a refused commit is a hard reset, which would take every
 * uncommitted file with it, so it wants the tree clean before it starts. */
async function requireMainReady(repoPath: string, defaultBr: string, clean: boolean): Promise<ShipResult | null> {
  const current = await git(repoPath, "branch", "--show-current");
  if (current.out !== defaultBr) {
    return { ok: false, message: `main checkout is on '${current.out}', not ${defaultBr}; switch it first` };
  }
  if (clean && (await statusFiles(repoPath)).length > 0) {
    return { ok: false, message: `${defaultBr} has uncommitted changes: commit or stash them there first` };
  }
  return null;
}

/** Take main into the branch: a rebase for a branch toyon owns, a merge for one it adopted. Both
 * leave the tree as it was on a conflict. */
export async function takeMainIn(
  worktreePath: string,
  defaultBr: string,
  own: boolean,
  w: LandWatch = UNWATCHED,
): Promise<ShipResult> {
  const cErr = await requireClean(worktreePath);
  if (cErr) return cErr;
  const { behind } = await aheadBehind(worktreePath, defaultBr);
  if (behind === 0) return { ok: true, message: `already up to date with ${defaultBr}` };
  if (own) {
    w.step(`rebasing onto ${defaultBr}`);
    const r = await w.git(worktreePath, ["rebase", defaultBr]);
    if (!r.ok) {
      await git(worktreePath, "rebase", "--abort");
      const ask = `rebase onto ${defaultBr} conflicts: ask the agent to bring ${defaultBr} in and resolve them`;
      return {
        ok: false,
        conflict: true,
        message: r.shown ? `${ask}; the conflicts are on the chat` : `${ask} (${r.text.slice(0, 200)})`,
      };
    }
    return { ok: true, message: `rebased onto ${defaultBr}, ${behind} commit(s) behind before` };
  }
  w.step(`merging ${defaultBr} in`);
  const m = await w.git(worktreePath, ["merge", "--no-edit", defaultBr]);
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
  w: LandWatch = UNWATCHED,
): Promise<ShipResult> {
  const cErr = await requireClean(worktreePath);
  if (cErr) return cErr;
  const { ahead } = await aheadBehind(worktreePath, defaultBr);
  if (ahead === 0) return { ok: false, message: `nothing to merge: no commits ahead of ${defaultBr}` };
  const mErr = await requireMainReady(repoPath, defaultBr, method === "squash");
  if (mErr) return mErr;
  if (method === "rebase") {
    w.step(`moving ${defaultBr} onto the branch`);
    const ff = await w.git(repoPath, ["merge", "--ff-only", branch]);
    if (!ff.ok) {
      const files = overwritten(ff.text);
      if (files.length) return { ok: false, message: inTheWay(defaultBr, "landing", files) };
      return { ok: false, message: `${branch} is not a fast-forward of ${defaultBr}: take ${defaultBr} in first` };
    }
    return { ok: true, message: `${defaultBr} moved onto ${branch}` };
  }
  if (method === "squash") {
    w.step(`squashing onto ${defaultBr}`);
    const s = await w.git(repoPath, ["merge", "--squash", branch]);
    if (!s.ok) {
      await git(repoPath, "reset", "--hard", "HEAD");
      return mergeFailure(repoPath, s, `merge conflicts with ${defaultBr}: take ${defaultBr} in first`);
    }
    const c = await w.git(repoPath, ["commit", "-m", message]);
    if (!c.ok) {
      await git(repoPath, "reset", "--hard", "HEAD");
      return { ok: false, message: refused("squash commit refused", c) };
    }
    return { ok: true, message: `squashed ${branch} onto ${defaultBr}` };
  }
  w.step(`merging into ${defaultBr}`);
  const m = await w.git(repoPath, ["merge", "--no-ff", "--no-edit", branch]);
  if (!m.ok) {
    const files = overwritten(m.text);
    if (files.length) return { ok: false, message: inTheWay(defaultBr, "landing", files) };
    return mergeFailure(repoPath, m, `merge conflicts with ${defaultBr}: take ${defaultBr} in first`);
  }
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

/** what a fast-forward onto the last fetch found: `moved` when main took commits, and why it was
 * left where it was otherwise, in the trunk's own words (see TrunkStatus.stale) */
export type TrunkFf = ShipResult & { moved?: boolean; stale?: TrunkStatus["stale"] };

/** The fast-forward alone, onto what the last fetch brought. The fetch is the slow half and holds
 * the network for seconds, so the trunk's own sync runs it outside the repo lock and takes only
 * this step inside. Git's own refusal of an uncommitted file the pull would overwrite is the
 * guard: main is `stale: "dirty"` with the files named, and every other uncommitted file on it
 * rides along untouched, as it would under a pull typed in a terminal. */
export async function fastForwardFetched(repoPath: string, defaultBr: string): Promise<TrunkFf> {
  const current = await git(repoPath, "branch", "--show-current");
  if (current.out !== defaultBr) {
    return { ok: false, message: `main checkout is on '${current.out}', not ${defaultBr}; switch it first` };
  }
  const behind = await behindUpstream(repoPath);
  if (behind === null) {
    return { ok: false, stale: "no-upstream", message: `${defaultBr} has no upstream to pull from` };
  }
  if (behind === 0) return { ok: true, moved: false, message: "already up to date with origin" };
  const m = await git(repoPath, "merge", "--ff-only", "@{upstream}");
  if (!m.ok) {
    const files = overwritten(`${m.out}\n${m.err}`);
    return files.length
      ? { ok: false, stale: "dirty", message: inTheWay(defaultBr, "pull", files) }
      : { ok: false, stale: "diverged", message: `${defaultBr} has diverged from origin; reconcile it in a terminal` };
  }
  return { ok: true, moved: true, message: `pulled ${behind} commit(s) from origin` };
}

/** What the push route lands: the branch's work over the base as one commit the repo's method
 * shapes, made in the worktree as a real commit so the repo's hooks run on what reaches main
 * (plumbing would skip commit-msg and pre-commit). HEAD holds the base already (takeMainIn), so
 * no merge here can conflict. A squash of toyon's own branch is the branch itself moved onto one
 * commit, since it restarts from the base after landing anyway; an adopted branch keeps its
 * history, so its squash, like every merge commit, is made on a detached HEAD at the base and the
 * branch is switched back to on every exit, a refused hook included. `sha` is what to push. */
export async function landingCommit(
  worktreePath: string,
  branch: string,
  base: string,
  method: MergeMethod,
  message: string,
  own: boolean,
  w: LandWatch = UNWATCHED,
): Promise<ShipResult & { sha?: string }> {
  const head = await git(worktreePath, "rev-parse", "HEAD");
  if (!head.ok) return { ok: false, message: `no HEAD to land: ${head.err.slice(0, 200)}` };
  if (method === "rebase") return { ok: true, sha: head.out, message: `${branch} as it is` };
  if (method === "squash" && own) {
    w.step(`squashing onto ${base}`);
    const r = await git(worktreePath, "reset", "--soft", base);
    if (!r.ok) return { ok: false, message: `could not squash onto ${base}: ${r.err.slice(0, 200)}` };
    const c = await w.git(worktreePath, ["commit", "-m", message]);
    if (!c.ok) {
      await git(worktreePath, "reset", "--soft", head.out);
      return { ok: false, message: refused("squash commit refused", c) };
    }
    const sha = await git(worktreePath, "rev-parse", "HEAD");
    return { ok: true, sha: sha.out, message: `squashed ${branch} onto ${base}` };
  }
  const detached = await git(worktreePath, "checkout", "-q", "--detach", base);
  if (!detached.ok) return { ok: false, message: `could not check out ${base}: ${detached.err.slice(0, 200)}` };
  try {
    if (method === "squash") {
      w.step(`squashing onto ${base}`);
      const s = await w.git(worktreePath, ["merge", "--squash", branch]);
      if (!s.ok) return { ok: false, message: refused("squash refused", s) };
      const c = await w.git(worktreePath, ["commit", "-m", message]);
      if (!c.ok) return { ok: false, message: refused("squash commit refused", c) };
    } else {
      w.step(`merging into ${base}`);
      // the subject git would write on main itself; on a detached HEAD it says "into HEAD"
      const m = await w.git(worktreePath, ["merge", "--no-ff", "-m", `Merge branch '${branch}'`, branch]);
      if (!m.ok) return { ok: false, message: refused("merge refused", m) };
    }
    const sha = await git(worktreePath, "rev-parse", "HEAD");
    return { ok: true, sha: sha.out, message: `${method === "squash" ? "squashed" : "merged"} ${branch} onto ${base}` };
  } finally {
    // a refused commit leaves the squash staged, and a refused merge leaves one in progress:
    // both go with the detached HEAD, which the tree was clean under, before the branch is back
    await git(worktreePath, "reset", "-q", "--hard");
    await git(worktreePath, "switch", "-q", branch);
  }
}

/** the remote and branch main tracks: where the base is fetched from and the landing pushed to */
export async function trackedRemote(
  worktreePath: string,
  defaultBr: string,
): Promise<{ remote: string; merge: string } | null> {
  const [remote, merge] = await Promise.all([
    git(worktreePath, "config", "--get", `branch.${defaultBr}.remote`),
    git(worktreePath, "config", "--get", `branch.${defaultBr}.merge`),
  ]);
  if (!remote.ok || !remote.out || !merge.ok || !merge.out) return null;
  return { remote: remote.out, merge: merge.out };
}

/** The landing commit pushed straight to main on origin, from the worktree. `moved` is git's own
 * word for a tip origin no longer has, which the route meets by fetching and building again; a
 * hook's output is on the same pipe, and a hook that prints "rejected" about a file is not origin
 * moving. */
export async function pushLanding(
  worktreePath: string,
  sha: string,
  defaultBr: string,
  w: LandWatch = UNWATCHED,
): Promise<ShipResult & { moved?: true }> {
  const tracked = await trackedRemote(worktreePath, defaultBr);
  if (!tracked) return { ok: false, message: `${defaultBr} tracks no remote branch to push to` };
  w.step(`pushing ${defaultBr}`);
  const p = await w.git(worktreePath, ["push", tracked.remote, `${sha}:${tracked.merge}`]);
  if (p.ok) return { ok: true, message: `pushed ${defaultBr} to ${tracked.remote}` };
  const moved = /\[rejected\]|fetch first|non-fast-forward|cannot lock ref/.test(p.err);
  return moved
    ? { ok: false, moved: true, message: `${defaultBr} on ${tracked.remote} moved while landing` }
    : { ok: false, message: refused("push failed", p, 300) };
}

/** A conflict leaves a merge in progress that must be aborted; any other failure (dirty index,
 * unrelated histories, hook) has nothing to abort and deserves its own message. Both streams are
 * read: git reports a conflict on stdout, and reading stderr alone left every real conflict as an
 * empty "merge failed" with the merge still in progress. */
async function mergeFailure(cwd: string, m: StepResult, conflictMessage: string): Promise<ShipResult> {
  const conflict = /CONFLICT|Automatic merge failed/.test(m.text);
  if (conflict) {
    await git(cwd, "merge", "--abort");
    return {
      ok: false,
      conflict: true,
      message: m.shown
        ? `${conflictMessage}; the conflicts are on the chat`
        : `${conflictMessage} (${m.text.slice(0, 200)})`,
    };
  }
  return {
    ok: false,
    message: m.shown ? "merge failed: what git printed is on the chat" : `merge failed: ${m.text.slice(0, 300)}`,
  };
}

/** The base fetched, so what follows (a count, a rebase) is against origin as it is now and not
 * as of the last fetch: a branch rebased onto a stale copy keeps a commit origin's main already
 * took through a merge on GitHub, where onto the fetched one git drops it as already applied.
 * The one branch, not the whole remote: a fetch of a hot monorepo is seconds nobody pressed
 * for. Nothing to do while the base is main here. */
export async function fetchBase(
  worktreePath: string,
  repo: Pick<RepoInfo, "defaultBranch" | "base">,
  w: LandWatch = UNWATCHED,
): Promise<ShipResult> {
  const base = baseOf(repo);
  if (!baseIsRemote(repo)) return { ok: true, message: `${base} here is the base` };
  const tracked = await trackedRemote(worktreePath, repo.defaultBranch);
  if (!tracked) return { ok: false, message: `${repo.defaultBranch} no longer tracks a branch to fetch ${base} from` };
  w.step(`fetching ${base}`);
  const f = await w.git(worktreePath, ["fetch", "--quiet", tracked.remote, tracked.merge]);
  if (!f.ok) return { ok: false, message: refused("fetch failed", f) };
  return { ok: true, message: `fetched ${base}` };
}

export interface OpenPr {
  worktreePath: string;
  branch: string;
  defaultBr: string;
  /** what the branch is counted against: main's fetched upstream (baseOf), else main here */
  base?: string;
  /** the PR's title and body: the suggested commit message when there is one */
  subject?: string;
  body?: string;
  automerge: boolean;
  /** the method auto-merge uses; unset follows the repo's allowed methods */
  method?: MergeMethod;
}

/** Push the branch to origin, tracking. Force with lease, since a branch already there was
 * rebased onto main since; the lease refuses when origin's copy moved under it.
 *
 * The lease is measured against `origin/<branch>` here, and that ref outlives the branch on
 * GitHub: a merged PR deletes its head branch, nothing here fetches with --prune, and the next
 * push from the same worktree is refused as "stale info" against a tip origin no longer has.
 * When origin says the branch is gone, the ref is dropped and the push is a first push again;
 * a branch that is there but moved keeps the refusal, since that is what the lease is for. */
export async function pushBranch(worktreePath: string, branch: string, w: LandWatch = UNWATCHED): Promise<ShipResult> {
  const args = ["push", "-u", "--force-with-lease", "origin", branch];
  w.step(`pushing ${branch}`);
  let push = await w.git(worktreePath, args);
  if (!push.ok && /stale info/.test(push.err) && (await goneFromOrigin(worktreePath, branch))) {
    await git(worktreePath, "update-ref", "-d", `refs/remotes/origin/${branch}`);
    push = await w.git(worktreePath, args);
  }
  if (!push.ok) return { ok: false, message: refused("push failed", push, 300) };
  return { ok: true, message: `pushed ${branch}` };
}

/** origin answers and has no branch of that name; exit 2 is ls-remote's own "nothing matched",
 * so an origin that cannot be reached (any other failure) reads as not gone */
async function goneFromOrigin(worktreePath: string, branch: string): Promise<boolean> {
  const r = await run(GIT, ["ls-remote", "--exit-code", "--heads", "origin", branch], worktreePath, NO_PROMPT);
  return !r.ok && r.exit === 2;
}

/** Push the branch and open a PR through gh, or hand back the compare URL where gh is not
 * around. A branch already on origin from an earlier push is force-pushed with lease, since it
 * was rebased since; a PR that already exists is found rather than made twice. */
export async function openPr(o: OpenPr, w: LandWatch = UNWATCHED): Promise<ShipResult> {
  const cErr = await requireClean(o.worktreePath);
  if (cErr) return cErr;
  const base = o.base ?? o.defaultBr;
  const { ahead } = await aheadBehind(o.worktreePath, base);
  if (ahead === 0) return { ok: false, message: `nothing to ship: no commits ahead of ${base}` };
  const remote = await git(o.worktreePath, "remote", "get-url", "origin");
  if (!remote.ok) return { ok: false, message: "no 'origin' remote: add one, or land by merging here" };

  const push = await pushBranch(o.worktreePath, o.branch, w);
  if (!push.ok) return push;

  w.step("opening the PR");
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

/** merge an open PR through gh, by the method the settings ask for or the repo allows */
export async function mergePr(
  worktreePath: string,
  number: number,
  wanted?: MergeMethod,
  w: LandWatch = UNWATCHED,
): Promise<ShipResult> {
  w.step("merging the PR");
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
