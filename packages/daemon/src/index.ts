import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFAULT_PORT } from "@orchardist/shared";
import { cloud } from "./core/cloud.ts";
import { fireAndForget, log } from "./core/log.ts";
import { ensureDirs, makePaths } from "./core/paths.ts";
import { loadOrCreateToken, saveState } from "./core/state.ts";
import { statusFilesWithCounts } from "./git/status.ts";
import { startServer } from "./server.ts";
import { ThemeStore } from "./themes/store.ts";
import { type HubEvents, Manager } from "./worktrees.ts";

// Bun exits the process on an unhandled rejection or exception. For a daemon that owns
// every dev server and agent session, staying up and logging beats taking them all down.
process.on("unhandledRejection", (e) => log.error("daemon", "unhandled rejection", e));
process.on("uncaughtException", (e) => log.error("daemon", "uncaught exception", e));

const here = dirname(fileURLToPath(import.meta.url));
const SHELL_DIST = join(here, "../../shell/dist");
const BRIDGE_JS = join(here, "../../bridge/dist/bridge.js");

const paths = makePaths();
ensureDirs(paths);
const token = loadOrCreateToken(paths);
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
          broadcastRef?.({ t: "git-status", worktreeId, files: statusFilesWithCounts(wt.path) });
        } catch (e) {
          log.warn(worktreeId, "git status after agent edit failed", e);
        }
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

const manager = new Manager(hubEvents, BRIDGE_JS, paths);
const themes = new ThemeStore(
  {
    get: () => manager.state.theme,
    set: (p) => {
      manager.state.theme = p;
      saveState(paths, manager.state);
    },
  },
  paths.themesDir,
);
themes.load();
const { hub, branded } = startServer({ port, token, manager, shellDist: SHELL_DIST, themes });
broadcastRef = hub.broadcast;
worktreesChangedRef = hub.worktreesChanged;

// every origin the shell can be loaded from: the injected bridge accepts commands from, and
// reports to, these only. Cloud without a known public host leaves it open (bridge falls back to "*").
manager.setShellOrigins(
  cloud.enabled
    ? cloud.publicHost
      ? [`https://${cloud.publicHost}`]
      : []
    : [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://orchardist.localhost:${port}`,
        ...(branded ? ["http://orchardist.localhost"] : []),
      ],
);

await manager.boot();

// register a repo passed on the command line (used by the CLI)
const repoArg = process.argv[2];
if (repoArg) {
  try {
    await manager.registerRepo(repoArg);
  } catch (e) {
    log.error("daemon", `could not register ${repoArg}`, e);
  }
}

if (cloud.enabled) {
  const range = cloud.proxyPorts ? `${cloud.proxyPorts.from}-${cloud.proxyPorts.to}` : "ephemeral";
  const where = cloud.publicHost ? `https://${cloud.publicHost}/` : `http://0.0.0.0:${port}/`;
  console.log(`orchardist daemon (cloud mode) on ${where}  proxy ports: ${range}`);
  console.log(`         token is seeded from ORCHARDIST_TOKEN; not printed`);
} else {
  const shellUrl = branded
    ? `http://orchardist.localhost/#token=${token}`
    : `http://orchardist.localhost:${port}/#token=${token}`;
  console.log(`orchardist daemon on ${shellUrl}`);
  console.log(`         (fallback: http://127.0.0.1:${port}/#token=${token})`);
}

// Wait for the dev servers to exit (SIGTERM, then SIGKILL after 3s) before leaving, so the
// detached process groups don't outlive the daemon and squat their ports. Bounded: a stuck
// exit can't hold the terminal hostage.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("daemon", `${signal}: stopping dev servers`);
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([manager.shutdown(), deadline]);
  process.exit(0);
}
process.on("SIGINT", () => fireAndForget("daemon", shutdown("SIGINT"), "shutdown"));
process.on("SIGTERM", () => fireAndForget("daemon", shutdown("SIGTERM"), "shutdown"));
