// git process wrapper + repo-level queries. Synchronous for now (phase 6 moves to Bun.spawn).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
