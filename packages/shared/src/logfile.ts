// The daemon's log file, opened for a detached daemon's stdout and stderr by whoever starts one:
// the CLI, and a daemon replacing itself. Node-only, like tailscale.ts; the shell never imports it.

import { chmodSync, existsSync, openSync, renameSync, statSync } from "node:fs";

/** a log past this is moved aside at the next start; one earlier generation is kept beside it */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** where the generation before the live log is kept */
export const previousLog = (path: string): string => `${path}.1`;

/** Open the log for appending, as a descriptor to hand a child's stdio. A file over the cutoff is
 * moved to `<path>.1` first, replacing the one before it, so the live file stays small enough to
 * read and to attach, and the months before it are still there. The log is the daemon's account of
 * what it did, so it is its owner's alone to read, a file from an earlier version included. */
export function openLog(path: string, maxBytes = LOG_ROTATE_BYTES): number {
  if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, previousLog(path));
  const fd = openSync(path, "a", 0o600);
  chmodSync(path, 0o600);
  return fd;
}
