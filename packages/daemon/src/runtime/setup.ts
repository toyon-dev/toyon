// A repo's setup commands, on a pty like everything else a worktree runs. `run()` from git/exec
// buffers to completion, so on it `bun install` would print nothing until it finished.

import { LineSplitter } from "./lines.ts";
import { PtyStream } from "./pty.ts";

/** setup output is read, not driven, so it keeps a small ring */
const SETUP_RING = 64 * 1024;
const SETUP_COLS = 120;
const SETUP_ROWS = 30;

/** what a setup command came back with: its exit code, or `timeout` for one killed at the ceiling */
export type SetupExit = number | "timeout";

export interface SetupOpts {
  /** a command still running at this is killed and reports `timeout` */
  timeoutMs?: number;
  /** the command is up: its process group, and the kill a stop presses */
  onSpawn?: (pid: number, stop: () => void) => void;
}

/** Run one setup command, streaming its lines as they land. Resolves with the exit code. `extra`
 * is what the command sees beyond the daemon's own env: the worktree id, so a setup step can
 * create a database or a compose project that is this worktree's alone. */
export function runSetup(
  cmd: string,
  cwd: string,
  onLine: (line: string, retract: number) => void,
  extra: Record<string, string> = {},
  opts: SetupOpts = {},
): Promise<SetupExit> {
  return new Promise((resolve) => {
    const lines = new LineSplitter();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const pty = new PtyStream(
        {
          cwd,
          env: { ...envStrings(process.env), TERM: "xterm-256color", COLORTERM: "truecolor", ...extra },
          cols: SETUP_COLS,
          rows: SETUP_ROWS,
          file: "sh",
          args: ["-c", cmd],
          ring: SETUP_RING,
        },
        (data) => {
          for (const ev of lines.feed(data)) onLine(ev.line, ev.retract);
        },
        (code) => {
          if (timer) clearTimeout(timer);
          resolve(timedOut ? "timeout" : code);
        },
      );
      // kill() resolves through onExit, which is what settles the promise
      const stop = () => {
        pty.kill().catch(() => {
          // a group already gone has nothing left to signal
        });
      };
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs);
      }
      opts.onSpawn?.(pty.pid, stop);
    } catch (e) {
      onLine(`could not run: ${e instanceof Error ? e.message : String(e)}`, 0);
      resolve(1);
    }
  });
}

/** bun-pty replaces the environment rather than merging, so it starts as the daemon's */
function envStrings(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") env[k] = v;
  return env;
}
