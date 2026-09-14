// `toyon restart`: stop the daemon and start a fresh one. For someone who has just rebuilt Toyon
// itself and wants the process to be the code they built. Everything the daemon holds goes with
// it - agent sessions resume, dev servers are started again by the worktrees that own them - so
// this is `toyon stop` followed by `toyon`, said in one word and without opening a browser.

import { health, logFile, startDaemon } from "./daemon.ts";
import { stop } from "./stop.ts";

export async function restart(): Promise<number> {
  const before = await health();
  if (before) {
    const code = await stop();
    if (code !== 0) return code;
  } else {
    console.log("Toyon was not running");
  }
  if (!(await startDaemon())) {
    console.error(`daemon failed to start; \`toyon logs\` shows why (${logFile})`);
    return 1;
  }
  const after = await health();
  console.log(`started Toyon${after?.pid !== undefined ? ` (pid ${after.pid})` : ""}`);
  return 0;
}
