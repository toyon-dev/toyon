import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFAULT_PORT } from "@orchardist/shared";
import { Manager, type HubEvents } from "./worktrees.ts";
import { startServer } from "./server.ts";
import { statusFiles } from "./git.ts";
import { loadOrCreateToken } from "./state.ts";
import { ensureDirs } from "./paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SHELL_DIST = join(here, "../../shell/dist");
const BRIDGE_JS = join(here, "../../bridge/dist/bridge.js");

ensureDirs();
const token = loadOrCreateToken();
const port = Number(process.env.ORCHARDIST_PORT ?? DAEMON_DEFAULT_PORT);

// hub wiring is circular (manager -> hub -> server -> manager); use a mutable shim
let broadcastRef: ((msg: import("@orchardist/shared").ServerMsg) => void) | null = null;
let worktreesChangedRef: (() => void) | null = null;

const hubEvents: HubEvents = {
  proc: (worktreeId, proc) => broadcastRef?.({ t: "proc", worktreeId, proc }),
  log: (worktreeId, proc, line) => broadcastRef?.({ t: "log", worktreeId, proc, line }),
  agent: (worktreeId, seq, event) => {
    broadcastRef?.({ t: "agent", worktreeId, seq, event });
    // keep the changes list live while the agent edits
    if (event.type === "tool-end" || event.type === "turn-end") {
      const wt = manager.worktree(worktreeId);
      if (wt) {
        try {
          broadcastRef?.({ t: "git-status", worktreeId, files: statusFiles(wt.path) });
        } catch {}
      }
    }
  },
  agentStatus: () => worktreesChangedRef?.(),
  queue: (worktreeId, items) => broadcastRef?.({ t: "queue", worktreeId, items }),
  worktreesChanged: () => worktreesChangedRef?.(),
  repoTick: (repoId) => {
    // main moved: refresh badges + git status for every worktree of the repo
    worktreesChangedRef?.();
    for (const wt of manager.state.worktrees.filter((w) => w.repoId === repoId)) {
      const msg = manager.gitStatusMsg(wt.id);
      if (msg) broadcastRef?.(msg);
    }
  },
};

const manager = new Manager(hubEvents, BRIDGE_JS);
const { hub } = startServer({ port, token, manager, shellDist: SHELL_DIST });
broadcastRef = hub.broadcast;
worktreesChangedRef = hub.worktreesChanged;

await manager.boot();

// register a repo passed on the command line (used by the CLI)
const repoArg = process.argv[2];
if (repoArg) {
  try {
    await manager.registerRepo(repoArg);
  } catch (e) {
    console.error(`could not register ${repoArg}: ${e}`);
  }
}

console.log(`orchardist daemon on http://127.0.0.1:${port}/#token=${token}`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
  manager.shutdown();
  process.exit(0);
}
