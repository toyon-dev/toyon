// `toyon stop`: SIGTERM the daemon (its handler stops every dev server and agent first) and wait
// for it to be gone, so the person's ports are free by the time the prompt returns.

import { rmSync } from "node:fs";
import { alive, health, pidFile, readPid } from "./daemon.ts";

/** the daemon's own shutdown is bounded at 5s; give it that and some */
const WAIT_MS = 10_000;

export async function stop(): Promise<number> {
  const h = await health();
  let pid = h?.pid ?? readPid();
  if (pid !== null && !alive(pid)) {
    // the file outlived a crash; nothing to stop
    rmSync(pidFile, { force: true });
    pid = null;
  }
  if (pid === null) {
    console.log("Toyon is not running");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    console.error(`could not signal pid ${pid}: ${(e as Error).message}`);
    return 1;
  }
  const deadline = Date.now() + WAIT_MS;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(100);
  if (alive(pid)) {
    process.kill(pid, "SIGKILL");
    console.error(
      `daemon (pid ${pid}) did not exit in ${WAIT_MS / 1000}s; killed. Dev servers it ran may still be up.`,
    );
    rmSync(pidFile, { force: true });
    return 1;
  }
  console.log(`stopped Toyon (pid ${pid})`);
  return 0;
}
