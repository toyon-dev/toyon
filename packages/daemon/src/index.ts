// Composition root: build every service once, wire them, start the server, handle signals.
// No logic lives here; if a line here starts making decisions it belongs in a service.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFAULT_PORT } from "@toyon/shared";
import pkg from "../package.json" with { type: "json" };
import { cloud } from "./core/cloud.ts";
import { Hub } from "./core/hub.ts";
import { fireAndForget, log } from "./core/log.ts";
import { startLagSampler } from "./core/metrics.ts";
import { ensureDirs, makePaths } from "./core/paths.ts";
import { loadOrCreateToken, StateStore } from "./core/state.ts";
import { FileService } from "./files/service.ts";
import { RepoRegistry } from "./repos/registry.ts";
import { BridgeScript } from "./runtime/bridge-script.ts";
import { RuntimeRegistry } from "./runtime/registry.ts";
import { startServer } from "./server/ws.ts";
import { ThemeStore } from "./themes/store.ts";
import { WorktreeService } from "./worktrees/service.ts";

// Bun exits the process on an unhandled rejection or exception. For a daemon that owns every
// dev server and agent session, staying up and logging beats taking them all down.
process.on("unhandledRejection", (e) => log.error("daemon", "unhandled rejection", e));
process.on("uncaughtException", (e) => log.error("daemon", "uncaught exception", e));

const here = dirname(fileURLToPath(import.meta.url));
const SHELL_DIST = join(here, "../../shell/dist");
const BRIDGE_JS = join(here, "../../bridge/dist/bridge.js");

const paths = makePaths();
ensureDirs(paths);
const token = loadOrCreateToken(paths);
const port = Number(process.env.TOYON_PORT ?? DAEMON_DEFAULT_PORT);

const state = new StateStore(paths);
const hub = new Hub();
const bridge = new BridgeScript(BRIDGE_JS);
const runtime = new RuntimeRegistry({ hub, state, paths, bridgeScript: () => bridge.get() });
const worktrees = new WorktreeService({ state, hub, runtime, paths });
const files = new FileService(state, runtime);
const repos = new RepoRegistry({ state, hub, runtime, worktrees });
const themes = new ThemeStore({ get: () => state.theme, set: (p) => state.setTheme(p) }, paths.themesDir);
themes.load();

const { branded, stop: stopServer } = startServer({
  port,
  token,
  shellDist: SHELL_DIST,
  version: pkg.version,
  services: { state, hub, repos, worktrees, files, runtime, themes },
});

// every origin the shell can be loaded from: the injected bridge accepts commands from, and
// reports to, these only. Cloud without a known public host leaves it open (bridge falls back to "*").
bridge.setShellOrigins(
  cloud.enabled
    ? cloud.publicHost
      ? [`https://${cloud.publicHost}`]
      : []
    : [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://toyon.localhost:${port}`,
        ...(branded ? ["http://toyon.localhost"] : []),
      ],
);

const stopLagSampler = startLagSampler();
if (cloud.enabled) {
  // decided, not implicit: preview proxies bind 0.0.0.0 with no auth of their own. The platform
  // (fly-replay / edge session check) must front them.
  log.warn("daemon", "cloud mode: preview proxy ports are unauthenticated — the platform edge must gate them");
}

await repos.boot();

// register a repo passed on the command line (used by the CLI)
const repoArg = process.argv[2];
if (repoArg) {
  try {
    await repos.register(repoArg);
  } catch (e) {
    log.error("daemon", `could not register ${repoArg}`, e);
  }
}

if (cloud.enabled) {
  const range = cloud.proxyPorts ? `${cloud.proxyPorts.from}-${cloud.proxyPorts.to}` : "ephemeral";
  const where = cloud.publicHost ? `https://${cloud.publicHost}/` : `http://0.0.0.0:${port}/`;
  console.log(`toyon daemon (cloud mode) on ${where}  proxy ports: ${range}`);
  console.log(`         token is seeded from TOYON_TOKEN; not printed`);
} else {
  const shellUrl = branded
    ? `http://toyon.localhost/#token=${token}`
    : `http://toyon.localhost:${port}/#token=${token}`;
  console.log(`toyon daemon on ${shellUrl}`);
  console.log(`         (fallback: http://127.0.0.1:${port}/#token=${token})`);
}

// Wait for the dev servers to exit (SIGTERM, then SIGKILL after 3s) before leaving, so the
// detached process groups don't outlive the daemon and squat their ports. Bounded: a stuck exit
// can't hold the terminal hostage.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("daemon", `${signal}: stopping dev servers`);
  repos.stopWatchers();
  stopLagSampler();
  stopServer();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([runtime.shutdown(), deadline]);
  process.exit(0);
}
process.on("SIGINT", () => fireAndForget("daemon", shutdown("SIGINT"), "shutdown"));
process.on("SIGTERM", () => fireAndForget("daemon", shutdown("SIGTERM"), "shutdown"));
