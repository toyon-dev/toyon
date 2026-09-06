// git process wrapper + repo-level queries. Synchronous for now (phase 6 moves to Bun.spawn).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lastGit } from "../core/metrics.ts";

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

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  /** exit status, or the signal name when git was killed (status null) */
  exit: number | string | null;
}

/**
 * The git binary. On macOS `/usr/bin/git` is an xcrun shim: ~3x slower per spawn than the real
 * binary and, under a burst of spawns, it can stall on xcrun's cache lock for seconds and abort
 * with SIGTERM. Resolve the real one once. ORCHARDIST_GIT overrides.
 */
export const GIT: string = resolveGit();

function resolveGit(): string {
  if (process.env.ORCHARDIST_GIT) return process.env.ORCHARDIST_GIT;
  if (process.platform !== "darwin") return "git";
  for (const p of [
    "/Library/Developer/CommandLineTools/usr/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
  ]) {
    if (existsSync(p)) return p;
  }
  return "git";
}

export function git(cwd: string, ...args: string[]): GitResult {
  const started = Date.now();
  const r = spawnSync(GIT, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  lastGit.cmd = `git ${args.slice(0, 3).join(" ")}`;
  lastGit.ms = Date.now() - started;
  lastGit.at = Date.now();
  const exit = r.status ?? r.signal ?? (r.error ? r.error.message : null);
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), exit };
}

export function gitOrThrow(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed (${r.exit}): ${r.err}`);
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
