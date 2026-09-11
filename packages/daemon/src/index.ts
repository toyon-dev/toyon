// Composition root: build every service once, wire them, start the server, handle signals.
// No logic lives here; if a line here starts making decisions it belongs in a service.

import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFAULT_PORT, SHELL_DEV_PORT } from "@toyon/shared";
import pkg from "../package.json" with { type: "json" };
import { AgentAccounts } from "./agent/accounts.ts";
import { spawnAcp } from "./agent/acp/transport.ts";
import { AttachmentStore } from "./agent/attachments.ts";
import { OptionProbe } from "./agent/probe.ts";
import { loadAgentRegistry } from "./agent/registry.ts";
import { makePlanner } from "./agent/tasks.ts";
import { locateAssets } from "./core/assets.ts";
import { cloud } from "./core/cloud.ts";
import { folderDialog } from "./core/dialog.ts";
import { Hub } from "./core/hub.ts";
import { fireAndForget, log } from "./core/log.ts";
import { startLagSampler } from "./core/metrics.ts";
import { ensureDirs, makePaths } from "./core/paths.ts";
import { loadOrCreateToken, StateStore } from "./core/state.ts";
import { DesignService } from "./design/service.ts";
import { ExecService } from "./exec/service.ts";
import { FileService } from "./files/service.ts";
import { RepoRegistry } from "./repos/registry.ts";
import { RouteService } from "./routes/service.ts";
import { BridgeScript } from "./runtime/bridge-script.ts";
import { RuntimeRegistry } from "./runtime/registry.ts";
import { startServer } from "./server/ws.ts";
import { ThemeStore } from "./themes/store.ts";
import { RefSearch } from "./worktrees/refs.ts";
import { WorktreeService } from "./worktrees/service.ts";

// Bun exits the process on an unhandled rejection or exception. For a daemon that owns every
// dev server and agent session, staying up and logging beats taking them all down.
process.on("unhandledRejection", (e) => log.error("daemon", "unhandled rejection", e));
process.on("uncaughtException", (e) => log.error("daemon", "uncaught exception", e));

const here = dirname(fileURLToPath(import.meta.url));
const { shellDist: SHELL_DIST, bridgeJs: BRIDGE_JS } = locateAssets(here);

const paths = makePaths();
ensureDirs(paths);
const token = loadOrCreateToken(paths);
const port = Number(process.env.TOYON_PORT ?? DAEMON_DEFAULT_PORT);

const state = new StateStore(paths);
const hub = new Hub();
const bridge = new BridgeScript(BRIDGE_JS);
const agents = loadAgentRegistry(paths.home, paths.agentsDir);
// A new worktree's picker lists every agent's models, and an agent nobody has run yet has listed
// none: once it is installed, a throwaway session reads them. The daemon's home is only where it runs.
const probe = new OptionProbe({
  infos: () => agents.infos(),
  require: (id) => agents.require(id),
  connect: (app, spec) => spawnAcp(app, agents.launch(spec), paths.home, `probe:${spec.id}`),
  cwd: paths.home,
  known: (id) => state.cachedOptions(id, "model").length > 0,
  learned: (id, category, choices) => {
    if (state.setCachedOptions(id, category, choices)) hub.emit("agentsChanged");
  },
});
agents.onChange = () => {
  hub.emit("agentsChanged");
  fireAndForget("agents", probe.missing(), "read agent models");
};
// a sign-out spawns the adapter on its own, with no session and no worktree: the daemon's home is
// only where the process runs, never written to
const accounts = new AgentAccounts({
  require: (id) => agents.require(id),
  connect: (app, spec) => spawnAcp(app, agents.launch(spec), paths.home, `auth:${spec.id}`),
});
accounts.onChange = () => hub.emit("agentsChanged");
const attachments = new AttachmentStore(paths.attachmentsDir);
const runtime = new RuntimeRegistry({
  hub,
  state,
  paths,
  agents,
  accounts,
  attachments,
  bridgeScript: () => bridge.get(),
});
const worktrees = new WorktreeService({ state, hub, runtime, paths, agents });
const files = new FileService(state, runtime, (id) => worktrees.readable(id));
const design = new DesignService((id) => worktrees.readable(id));
const routes = new RouteService({ state, hub, readable: (id) => worktrees.readable(id) });
const exec = new ExecService({ state, runtime });
const refs = new RefSearch({ state });
const repos = new RepoRegistry({ state, hub, runtime, worktrees });
const themes = new ThemeStore({ get: () => state.theme, set: (p) => state.setTheme(p) }, paths.themesDir);
themes.load();

const { branded, stop: stopServer } = startServer({
  port,
  token,
  shellDist: SHELL_DIST,
  version: pkg.version,
  noteShellOrigin: (origin) => bridge.learnShellOrigin(origin),
  services: {
    state,
    hub,
    repos,
    worktrees,
    files,
    design,
    routes,
    runtime,
    exec,
    refs,
    themes,
    agents,
    accounts,
    attachments,
    planTasks: makePlanner(agents, state),
    chooseFolder: folderDialog(),
  },
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
        // the Vite dev shell frames the same previews
        `http://127.0.0.1:${SHELL_DEV_PORT}`,
        `http://localhost:${SHELL_DEV_PORT}`,
      ],
);

// after the bind, so a second daemon that lost the port never overwrites the first one's pid
writeFileSync(paths.pidFile, `${process.pid}\n`);

const stopLagSampler = startLagSampler();
if (cloud.enabled) {
  // decided, not implicit: preview proxies bind 0.0.0.0 with no auth of their own. The platform
  // (fly-replay / edge session check) must front them.
  log.warn("daemon", "cloud mode: preview proxy ports are unauthenticated; the platform edge must gate them");
}

await repos.boot();
// the adapters are fetched on first boot (and after a version bump), not shipped: the default
// agent first, so the first prompt waits on one download at most. One already on disk installs
// without a change event, so the probe is asked here as well.
fireAndForget(
  "agents",
  agents.installMissing().then(() => probe.missing()),
  "agent adapter install",
);

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
  // the visits still waiting on their coalesced write; a clean stop should not lose them
  routes.flush();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([runtime.shutdown(), deadline]);
  // a crash leaves the file behind on purpose: `toyon stop` checks the pid is alive before trusting it
  rmSync(paths.pidFile, { force: true });
  process.exit(0);
}
process.on("SIGINT", () => fireAndForget("daemon", shutdown("SIGINT"), "shutdown"));
process.on("SIGTERM", () => fireAndForget("daemon", shutdown("SIGTERM"), "shutdown"));
