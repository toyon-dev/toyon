import type { ChildProcess } from "node:child_process";

/** SIGTERM the process group, SIGKILL after 3s. Resolves once the child has exited (or shortly
 * after the SIGKILL), so a daemon shutdown can wait for its children instead of orphaning them.
 * The child must have been spawned `detached` (its own group) for kill(-pid) to reach grandchildren. */
export function killProcessGroup(child: ChildProcess | undefined): Promise<void> {
  const pid = child?.pid;
  if (!child || !pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once("exit", finish);
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // group already gone: nothing to wait for
      finish();
      return;
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
      // the exit event follows the SIGKILL almost immediately; don't hang on a stuck one
      setTimeout(finish, 200);
    }, 3000);
  });
}
