import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitFileStatus } from "@orchardist/shared";

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "Cargo.lock",
];

/** Combined hash of all present lockfiles — spare deps re-setup only when this changes. */
export function lockfileHash(dir: string): string {
  const h = createHash("sha1");
  for (const f of LOCKFILES) {
    try {
      h.update(readFileSync(join(dir, f)));
    } catch {}
  }
  return h.digest("hex");
}

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
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return parsePorcelain(r.stdout ?? "");
}

/** `git status --porcelain` (v1) → entries. Renames/copies (`R  old -> new`) report the NEW path:
 * that is the file that exists on disk, and what file-diff / discard act on. Quoted paths are unquoted. */
export function parsePorcelain(out: string): GitFileStatus[] {
  const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p);
  return out
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const xy = line.slice(0, 2);
      const rest = line.slice(3);
      const arrow = xy.includes("R") || xy.includes("C") ? rest.lastIndexOf(" -> ") : -1;
      return { xy, path: unquote(arrow >= 0 ? rest.slice(arrow + 4) : rest) };
    });
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

type LineCounts = Pick<GitFileStatus, "add" | "del">;

/** `git diff --numstat` for the given range, keyed by path. Binary files map to {}. */
function numstat(worktreePath: string, ...range: string[]): Map<string, LineCounts> {
  const out = new Map<string, LineCounts>();
  const r = git(worktreePath, "diff", "--numstat", "--no-renames", ...range);
  if (!r.ok) return out;
  for (const line of r.out.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t").replace(/^"(.*)"$/, "$1");
    if (!path) continue;
    out.set(path, a === "-" || d === "-" ? {} : { add: Number(a), del: Number(d) });
  }
  return out;
}

/** Line count of an untracked file (all insertions). Undefined for binaries and directories. */
function untrackedLines(worktreePath: string, file: string): LineCounts {
  try {
    const buf = readFileSync(join(worktreePath, file));
    if (buf.subarray(0, 8000).includes(0)) return {};
    if (buf.length === 0) return { add: 0, del: 0 };
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf[buf.length - 1] !== 10) n++;
    return { add: n, del: 0 };
  } catch {
    return {};
  }
}

/** Uncommitted files with +/- line counts vs HEAD (staged and unstaged combined). */
export function statusFilesWithCounts(worktreePath: string): GitFileStatus[] {
  const files = statusFiles(worktreePath);
  if (files.length === 0) return files;
  const counts = files.some((f) => f.xy !== "??") ? numstat(worktreePath, "HEAD") : new Map<string, LineCounts>();
  return files.map((f) => ({
    ...f,
    ...(f.xy === "??" ? untrackedLines(worktreePath, f.path) : (counts.get(f.path) ?? {})),
  }));
}

/** Files changed between merge-base with main and HEAD (committed, not yet landed). */
export function committedFiles(worktreePath: string, defaultBr: string): GitFileStatus[] {
  const base = git(worktreePath, "merge-base", "HEAD", defaultBr);
  if (!base.ok || !base.out) return [];
  const r = git(worktreePath, "diff", "--name-status", base.out, "HEAD");
  if (!r.ok || !r.out) return [];
  const counts = numstat(worktreePath, base.out, "HEAD");
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      const path = rest[rest.length - 1] ?? "";
      return { xy: `${(status ?? "M").slice(0, 1)} `, path, ...(counts.get(path) ?? {}) };
    });
}

/** Changed line ranges (new-file numbering) for one file vs merge-base with main,
 * including uncommitted work. Untracked files return one open-ended range. */
export function changedRanges(worktreePath: string, defaultBr: string, file: string): Array<[number, number]> {
  const status = statusFiles(worktreePath).find((f) => f.path === file);
  if (status?.xy === "??") return [[1, 1_000_000]];
  const base = git(worktreePath, "merge-base", "HEAD", defaultBr);
  const ref = base.ok && base.out ? base.out : "HEAD";
  const r = git(worktreePath, "diff", "-U0", ref, "--", file);
  if (!r.ok) return [];
  const ranges: Array<[number, number]> = [];
  for (const m of r.out.matchAll(/^@@ [^+]*\+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

export function aheadBehind(worktreePath: string, defaultBr: string): { ahead: number; behind: number } {
  const a = git(worktreePath, "rev-list", "--count", `${defaultBr}..HEAD`);
  const b = git(worktreePath, "rev-list", "--count", `HEAD..${defaultBr}`);
  return { ahead: Number(a.out) || 0, behind: Number(b.out) || 0 };
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

// Per-repo mutex for daemon-initiated mutations of shared git state
// (branch create/delete, worktree add/remove, spare refresh). Agent commits in
// their own worktrees need no coordination (separate indexes).
const locks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    repoPath,
    next.catch(() => {}),
  );
  return next;
}
