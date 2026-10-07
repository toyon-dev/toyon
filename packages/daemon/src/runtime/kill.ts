import type { ChildProcess } from "node:child_process";

/** grace between SIGTERM and SIGKILL */
const KILL_GRACE_MS = 3000;
/** a SIGKILLed process exits almost immediately; don't hang on a stuck one */
const EXIT_GRACE_MS = 200;

/** SIGTERM the process group, SIGKILL after the grace. Resolves once `exited` settles and nothing
 * in the group answers any more (or shortly after the SIGKILL), so a shutdown can wait for its
 * children instead of orphaning them, with the signal that ended the group, or nothing when it
 * was already gone. The leader's exit alone does not settle it: a member that handles SIGTERM
 * itself (vite closes its server before it exits) can outlive the leader, and one whose close
 * hangs would otherwise sit under launchd with the dead leader's group id, out of reach. The
 * process must own its group: spawned `detached`, or setsid()'d by a pty. */
export async function killGroup(
  pid: number,
  exited: Promise<void>,
  graceMs = KILL_GRACE_MS,
): Promise<NodeJS.Signals | undefined> {
  if (!signalGroup(pid, "SIGTERM")) return undefined;
  const deadline = Date.now() + graceMs;
  if (await within(exited, graceMs)) {
    await groupGone(pid, deadline);
    if (!groupAlive(pid)) return "SIGTERM";
  }
  signalGroup(pid, "SIGKILL");
  await Promise.all([within(exited, EXIT_GRACE_MS), groupGone(pid, Date.now() + EXIT_GRACE_MS)]);
  return "SIGKILL";
}

/** the same policy for a node child, which carries its own exit event and liveness */
export async function killProcessGroup(child: ChildProcess | undefined): Promise<void> {
  const pid = child?.pid;
  if (!child || !pid || child.exitCode !== null || child.signalCode !== null) return;
  await killGroup(pid, new Promise<void>((r) => child.once("exit", () => r())));
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

/** true while anything in the group answers a signal */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    // ESRCH: gone. Anything else (EPERM) means something in it is alive
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Resolves once nothing in the group answers a signal, or at `deadline`, so a group that will
 * not die never keeps a timer alive. For a group this process did not spawn, which gives no exit
 * event, or one whose leader has exited while its children hold on. The default deadline is as
 * long as killGroup can be waiting on it. */
export function groupGone(pgid: number, deadline = Date.now() + KILL_GRACE_MS + EXIT_GRACE_MS + 500): Promise<void> {
  return new Promise<void>((resolve) => {
    const poll = () => {
      if (!groupAlive(pgid) || Date.now() >= deadline) return resolve();
      setTimeout(poll, GONE_POLL_MS).unref?.();
    };
    poll();
  });
}

/** the group policy for a group left by another daemon: no child, no exit event */
export async function reclaimGroup(pgid: number): Promise<void> {
  await killGroup(pgid, groupGone(pgid));
}
