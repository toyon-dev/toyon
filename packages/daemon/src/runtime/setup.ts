// A repo's setup commands, on a pty like everything else a worktree runs. `run()` from git/exec
// buffers to completion, so `bun install` used to print nothing until it finished and then have
// its output thrown away: first run, when someone is watching hardest, showed one summary line.

import { LineSplitter } from "./lines.ts";
import { PtyStream } from "./pty.ts";

/** setup output is read, not driven, so it keeps a small ring */
const SETUP_RING = 64 * 1024;
const SETUP_COLS = 120;
const SETUP_ROWS = 30;

/** Run one setup command, streaming its lines as they land. Resolves with the exit code. */
export function runSetup(cmd: string, cwd: string, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const lines = new LineSplitter();
    try {
      new PtyStream(
        {
          cwd,
          env: { ...envStrings(process.env), TERM: "xterm-256color", COLORTERM: "truecolor" },
          cols: SETUP_COLS,
          rows: SETUP_ROWS,
          file: "sh",
          args: ["-c", cmd],
          ring: SETUP_RING,
        },
        (data) => {
          for (const line of lines.feed(data)) onLine(line);
        },
        resolve,
      );
    } catch (e) {
      onLine(`could not run: ${e instanceof Error ? e.message : String(e)}`);
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
