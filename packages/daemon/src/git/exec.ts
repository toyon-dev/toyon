// git process wrapper + repo-level queries, async on Bun.spawn so git never blocks the event loop.

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
    } catch {
      // absent lockfile: not part of the hash
    }
  }
  return h.digest("hex");
}

/**
 * The git binary. On macOS `/usr/bin/git` is an xcrun shim: ~3x slower per spawn than the real
 * binary and, under a burst of spawns, it can stall on xcrun's cache lock for seconds and abort
 * with SIGTERM. Resolve the real one once. TOYON_GIT overrides.
 */
export const GIT: string = resolveGit();

function resolveGit(): string {
  if (process.env.TOYON_GIT) return process.env.TOYON_GIT;
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

/**
 * Env for a git command that talks to a remote, so it fails instead of waiting for a human.
 * `stdin: "ignore"` is not enough on its own: git opens `/dev/tty` directly for a credential
 * prompt and ssh blocks on a passphrase the same way, so a clone of a URL the machine has no
 * credential for would hang a daemon process nobody can see, with the shell still saying "cloning".
 *
 * Host keys are deliberately not auto-accepted. `StrictHostKeyChecking=accept-new` would make a
 * first-ever ssh clone work, at the cost of the daemon silently trusting a key on the person's
 * behalf. Failing with ssh's own "host key verification failed" is the honest outcome: they can
 * clone once in a terminal, or use https.
 */
export const NO_PROMPT: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  /** exit status, or the signal name when the process was killed (status null) */
  exit: number | string | null;
}

/** run a command to completion without blocking the event loop (a proxy request or agent stream
 * keeps flowing while git works). A spawn failure (cwd gone, binary missing) is a result, not a throw.
 * `env` is merged over the daemon's own, for the few commands that must be told not to ask. */
export async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<GitResult & { rawOut: string }> {
  const started = Date.now();
  try {
    // env is always passed explicitly rather than left to Bun's default: that default is a snapshot
    // taken at startup, so a variable set later in the process lifetime would not reach git
    const p = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, ...env },
    });
    const [rawOut, err, status] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    const exit = p.signalCode ?? status;
    return { ok: status === 0, out: rawOut.trim(), rawOut, err: err.trim(), exit };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, out: "", rawOut: "", err: msg, exit: msg };
  } finally {
    if (cmd === GIT) {
      lastGit.cmd = `git ${args.slice(0, 3).join(" ")}`;
      lastGit.ms = Date.now() - started;
      lastGit.at = Date.now();
    }
  }
}

export async function git(cwd: string, ...args: string[]): Promise<GitResult> {
  const { rawOut: _raw, ...r } = await run(GIT, args, cwd);
  return r;
}

/** like git() but stdout untrimmed — porcelain lines for unstaged changes start with a significant space */
export async function gitRaw(cwd: string, ...args: string[]): Promise<GitResult> {
  const { rawOut, ...r } = await run(GIT, args, cwd);
  return { ...r, out: rawOut };
}

export async function gitOrThrow(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed (${r.exit}): ${r.err}`);
  return r.out;
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await git(path, "rev-parse", "--is-inside-work-tree")).out === "true";
}

export function repoRoot(path: string): Promise<string> {
  return gitOrThrow(path, "rev-parse", "--show-toplevel");
}

export async function defaultBranch(path: string): Promise<string> {
  const head = await git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (head.ok && head.out) return head.out.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if ((await git(path, "show-ref", "--verify", `refs/heads/${b}`)).ok) return b;
  }
  return gitOrThrow(path, "branch", "--show-current");
}
