import type { ChildProcess } from "node:child_process";

/** grace between SIGTERM and SIGKILL */
const KILL_GRACE_MS = 3000;
/** a SIGKILLed process exits almost immediately; don't hang on a stuck one */
const EXIT_GRACE_MS = 200;

/** SIGTERM the process group, SIGKILL after 3s. Resolves once `exited` settles (or shortly after
 * the SIGKILL), so a shutdown can wait for its children instead of orphaning them. The process
 * must own its group: spawned `detached`, or setsid()'d by a pty. */
export async function killGroup(pid: number, exited: Promise<void>): Promise<void> {
  if (!signalGroup(pid, "SIGTERM")) return;
  if (await within(exited, KILL_GRACE_MS)) return;
  signalGroup(pid, "SIGKILL");
  await within(exited, EXIT_GRACE_MS);
}

/** the same policy for a node child, which carries its own exit event and liveness */
export function killProcessGroup(child: ChildProcess | undefined): Promise<void> {
  const pid = child?.pid;
  if (!child || !pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return killGroup(pid, new Promise<void>((r) => child.once("exit", () => r())));
}

/** false when the group is already gone, so there is nothing to wait for */
function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    // ESRCH: the group exited between the caller's check and this signal
    return false;
  }
}

/** true if `p` settled inside `ms` */
async function within(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const done = await Promise.race([p.then(() => true), timeout]);
  clearTimeout(timer);
  return done;
}

/** how often a group that is not this process's child is asked whether it is still there */
const GONE_POLL_MS = 100;

/** Resolves once nothing in the group answers a signal. For a group this process did not spawn,
 * which gives no exit event. Polls only as long as killGroup can be waiting on it: past that it
 * resolves regardless, so a group that will not die never keeps a timer alive. */
export function groupGone(pgid: number): Promise<void> {
  const deadline = Date.now() + KILL_GRACE_MS + EXIT_GRACE_MS + 500;
  return new Promise<void>((resolve) => {
    const poll = () => {
      try {
        process.kill(-pgid, 0);
      } catch (e) {
        // ESRCH: gone. Anything else (EPERM) means something in it is alive
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return resolve();
      }
      if (Date.now() >= deadline) return resolve();
      setTimeout(poll, GONE_POLL_MS).unref?.();
    };
    poll();
  });
}

/** the group policy for a group left by another daemon: no child, no exit event */
export function reclaimGroup(pgid: number): Promise<void> {
  return killGroup(pgid, groupGone(pgid));
}
