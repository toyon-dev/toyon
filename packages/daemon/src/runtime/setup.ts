// A repo's setup commands, on a pty like everything else a worktree runs. `run()` from git/exec
// buffers to completion, so on it `bun install` would print nothing until it finished.

import { LineSplitter } from "./lines.ts";
import { PtyStream } from "./pty.ts";

/** setup output is read, not driven, so it keeps a small ring */
const SETUP_RING = 64 * 1024;
const SETUP_COLS = 120;
const SETUP_ROWS = 30;

/** Run one setup command, streaming its lines as they land. Resolves with the exit code. `extra`
 * is what the command sees beyond the daemon's own env: the worktree id, so a setup step can
 * create a database or a compose project that is this worktree's alone. */
export function runSetup(
  cmd: string,
  cwd: string,
  onLine: (line: string, retract: number) => void,
  extra: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve) => {
    const lines = new LineSplitter();
    try {
      new PtyStream(
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
        resolve,
      );
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
