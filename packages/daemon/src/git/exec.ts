// git process wrapper + repo-level queries, async on Bun.spawn so git never blocks the event loop.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fireAndForget } from "../core/log.ts";
import { lastGit } from "../core/metrics.ts";
import { killGroup } from "../runtime/kill.ts";

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

/**
 * Env every spawn gets. `GIT_OPTIONAL_LOCKS=0`: a read such as `git status` opportunistically
 * refreshes stale stat data and writes the index back through `.git/index.lock`. The daemon reads
 * the main checkout's status every few seconds, so a `git pull` typed in a terminal at that moment
 * failed with "Unable to create index.lock: File exists". With the switch, a read never takes the lock.
 */
const SPAWN_ENV: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0" };

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
      env: { ...process.env, ...SPAWN_ENV, ...env },
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

/**
 * Like `run`, but for a command worth watching: stderr is reported line by line as it arrives, and
 * an abort signal kills the process. `run` buffers both pipes to completion and never exposes the
 * child, which is right for the hundreds of sub-second git calls and useless for a clone that can
 * run for minutes and that someone may want to stop.
 *
 * Progress is split on `\r` as well as `\n`: git redraws a counter in place, so a whole clone's
 * progress is one `\n`-terminated line and reading by newline alone reports nothing until the end.
 */
export async function runLive(
  cmd: string,
  args: string[],
  cwd: string,
  opts: { env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<GitResult> {
  const started = Date.now();
  try {
    const p = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, ...SPAWN_ENV, ...opts.env },
    });
    const stop = () => p.kill();
    opts.signal?.addEventListener("abort", stop, { once: true });
    const err: string[] = [];
    const pump = async () => {
      const dec = new TextDecoder();
      const reader = (p.stderr as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split(/[\r\n]/);
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line) continue;
          err.push(line);
          opts.onLine?.(line);
        }
      }
      const last = buf.trim();
      if (last) {
        err.push(last);
        opts.onLine?.(last);
      }
    };
    const [out, , status] = await Promise.all([new Response(p.stdout).text(), pump(), p.exited]);
    opts.signal?.removeEventListener("abort", stop);
    const exit = p.signalCode ?? status;
    return { ok: status === 0 && !opts.signal?.aborted, out: out.trim(), err: err.join("\n"), exit };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, out: "", err: msg, exit: msg };
  } finally {
    if (cmd === GIT) {
      lastGit.cmd = `git ${args.slice(0, 3).join(" ")}`;
      lastGit.ms = Date.now() - started;
      lastGit.at = Date.now();
    }
  }
}

/** what a watched command left: the two pipes apart, as `run` gives them, and together in
 * arrival order, which is as close to what a terminal showed as two pipes allow */
export type Watched = GitResult & { text: string };

/**
 * Like `run`, for a command whose output someone may be reading while it runs: a git step that
 * runs hooks (a commit, a push), where a hook's test run prints for minutes. Both pipes are read
 * as they arrive and each chunk goes to `onText` in order; `runLive` reports stderr line by line
 * for a counter git redraws in place, which is a different reading. A command still running at
 * `timeoutMs` is killed and comes back with `exit: "timeout"`, so a hook that waits on something
 * nobody can answer cannot hold its caller forever; an abort on `signal` kills it the same way
 * and comes back with the signal's name, for a stop pressed on its row.
 *
 * A node spawn, detached: git runs a hook as a child in its own group, and a signal to git alone
 * left the hook's test suite running, holding the pipes and the row open until it was done on its
 * own. Killing the group ends the suite with git.
 */
export function runWatched(
  cmd: string,
  args: string[],
  cwd: string,
  opts: {
    env?: Record<string, string>;
    onText?: (text: string) => void;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Watched> {
  const started = Date.now();
  return new Promise<Watched>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let stop: (() => void) | undefined;
    let settled = false;
    const settle = (r: Watched) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stop) opts.signal?.removeEventListener("abort", stop);
      if (cmd === GIT) {
        lastGit.cmd = `git ${args.slice(0, 3).join(" ")}`;
        lastGit.ms = Date.now() - started;
        lastGit.at = Date.now();
      }
      resolve(r);
    };
    const failed = (msg: string) => settle({ ok: false, out: "", err: msg, exit: msg, text: msg });
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, ...SPAWN_ENV, ...opts.env },
      });
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e));
      return;
    }
    child.on("error", (e) => failed(e.message));
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const kill = () => {
      if (child.pid) fireAndForget("git", killGroup(child.pid, exited), `stopping ${cmd} ${args[0] ?? ""}`);
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
    }
    if (opts.signal) {
      stop = kill;
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", stop, { once: true });
    }
    let text = "";
    const out: string[] = [];
    const err: string[] = [];
    const read = (stream: Readable | null, into: string[]) => {
      const dec = new TextDecoder();
      stream?.on("data", (b: Buffer) => {
        const chunk = dec.decode(b, { stream: true });
        into.push(chunk);
        text += chunk;
        opts.onText?.(chunk);
      });
    };
    read(child.stdout, out);
    read(child.stderr, err);
    // close, not exit: the pipes stay open until the last child of the group lets go of them
    child.on("close", (code, signal) => {
      const exit = timedOut ? "timeout" : (signal ?? code);
      settle({ ok: code === 0 && !timedOut, out: out.join("").trim(), err: err.join("").trim(), exit, text });
    });
  });
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
