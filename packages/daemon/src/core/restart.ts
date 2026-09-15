// Stopping the daemon and starting it again from the same entry, so that code landed on toyon's
// own default branch is code that is running. The daemon holds every agent session, dev server and
// terminal, so this is a real interruption and never something to do quietly: the shell asks, and
// the answer waits for a moment when no turn is in flight.
//
// The new process is detached and writes to the daemon log, the same as the one the CLI starts.
// It has to be: the old process is on its way out, and a child of it would go down with it.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { log } from "./log.ts";

/** Whether this daemon is allowed to replace itself, and what to say when it is not.
 *
 * A daemon running as one of toyon's own procs is the case that matters: its supervisor owns its
 * process group and its port, and a detached copy of it would come up beside whatever the
 * supervisor started next, with both holding the same $PORT. That one restarts from the proc's
 * tab, which is where its output already is. */
export function restartable(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; reason: string } {
  if (env.TOYON_WORKTREE !== undefined) {
    return { ok: false, reason: "this daemon runs as a toyon process; restart it from its terminal tab" };
  }
  return { ok: true };
}

/** Start the replacement, writing to `logFile` as the CLI's own start does. Call this last, after
 * the listener is closed: the replacement binds the same port and has no retry, so a spawn before
 * the port is free is a daemon that is simply gone. Nothing here waits for it to come up; the
 * shell reconnects on its own and says so when it cannot. */
export function respawn(logFile: string): void {
  const logFd = openSync(logFile, "a");
  // the bun running this daemon, and the arguments it was given: the entry is argv[1] in the
  // source tree and in the npm package alike, so the replacement starts exactly as this one did
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  // a spawn that fails emits error and never exit; unhandled, that throws in the old process on its
  // way out, with nothing in the log to say the replacement never started
  child.on("error", (e) => log.warn("daemon", `the replacement did not start: ${e.message}`));
  child.unref();
}
