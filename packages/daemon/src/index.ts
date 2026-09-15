// Composition root: build every service once, wire them, start the server, handle signals.
// No logic lives here; if a line here starts making decisions it belongs in a service.

import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addressedByPort, CHECK_TOOL, DAEMON_DEFAULT_PORT, PREVIEW_PORTS, SHELL_DEV_PORT } from "@toyon/shared";
import pkg from "../package.json" with { type: "json" };
import { AgentAccounts } from "./agent/accounts.ts";
import { spawnAcp } from "./agent/acp/transport.ts";
import { AttachmentStore } from "./agent/attachments.ts";
import { LinuxSandbox } from "./agent/linuxSandbox.ts";
import { OptionProbe } from "./agent/probe.ts";
import { loadAgentRegistry } from "./agent/registry.ts";
import { prepareLaunch } from "./agent/sandbox.ts";
import { makeLander, makePlanner, makeRecapper } from "./agent/tasks.ts";
import { transcriptPathFor } from "./agent/transcript.ts";
import { locateAssets, pruneAssets } from "./core/assets.ts";
import { folderDialog } from "./core/dialog.ts";
import { Hub } from "./core/hub.ts";
import { fireAndForget, log } from "./core/log.ts";
import { startLagSampler } from "./core/metrics.ts";
import { ensureDirs, makePaths } from "./core/paths.ts";
import { loadRemote, previewGrant } from "./core/remote.ts";
import { respawn, restartable } from "./core/restart.ts";
import { SelfWatch } from "./core/self.ts";
import { loadOrCreateToken, StateStore } from "./core/state.ts";
import { DesignService } from "./design/service.ts";
import { ExecService } from "./exec/service.ts";
import { FileService } from "./files/service.ts";
import { viewPr } from "./git/gh.ts";
import { AfterLand } from "./repos/afterLand.ts";
import { RepoRegistry } from "./repos/registry.ts";
import { RouteService } from "./routes/service.ts";
import { BridgeScript } from "./runtime/bridge-script.ts";
import { IdlePolicy } from "./runtime/idle.ts";
import { pinProxyPorts } from "./runtime/ports.ts";
import { RuntimeRegistry } from "./runtime/registry.ts";
import { startServer } from "./server/ws.ts";
import { ThemeStore } from "./themes/store.ts";
import { ChatSearch } from "./worktrees/chats.ts";
import { LandingService } from "./worktrees/landing.ts";
import { PrService } from "./worktrees/prs.ts";
import { RefSearch } from "./worktrees/refs.ts";
import { WorktreeService } from "./worktrees/service.ts";
import { TurnService } from "./worktrees/turns.ts";

// Bun exits the process on an unhandled rejection or exception. For a daemon that owns every
// dev server and agent session, staying up and logging beats taking them all down.
process.on("unhandledRejection", (e) => log.error("daemon", "unhandled rejection", e));
process.on("uncaughtException", (e) => log.error("daemon", "uncaught exception", e));

const here = dirname(fileURLToPath(import.meta.url));
const { shellDist: SHELL_DIST, bridgeJs: BRIDGE_JS, sourceRoot: SOURCE_ROOT } = locateAssets(here);
// the shell keeps every build's chunks so a tab open across a rebuild can still load its own; the
// ones no tab can still be holding go here, once, where no build is part-way through writing
const pruned = pruneAssets(SHELL_DIST);
if (pruned > 0) log.debug("daemon", `pruned ${pruned} assets from builds this one has outlived`);

const paths = makePaths();
ensureDirs(paths);
const token = loadOrCreateToken(paths);
const port = Number(process.env.TOYON_PORT ?? DAEMON_DEFAULT_PORT);
// the public name: an edge's from the environment, a local front's from `toyon remote`
const remote = loadRemote(paths.remoteFile);
// a front that addresses previews by port has each one declared to it, so they cannot be ephemeral
if (remote && addressedByPort(remote.previews)) pinProxyPorts(PREVIEW_PORTS);

const state = new StateStore(paths);
const hub = new Hub();
const bridge = new BridgeScript(BRIDGE_JS);
// on Linux, whether bubblewrap can start, answered before the first agent listing
const linuxSandbox = new LinuxSandbox();
await linuxSandbox.refresh();
const agents = loadAgentRegistry(paths.agentsFile, paths.agentsDir, linuxSandbox);
// A new worktree's picker lists every agent's models, and an agent nobody has run yet has listed
// none: once it is installed, a throwaway session reads them. It runs in the daemon's scratch
// directory, prepared like any other launch, so an agent in toyon's sandbox is confined there too.
const probe = new OptionProbe({
  infos: () => agents.infos(),
  require: (id) => agents.require(id),
  connect: async (app, spec) =>
    spawnAcp(
      app,
      agents.launch(spec, await prepareLaunch(paths.scratchDir, spec)),
      paths.scratchDir,
      `probe:${spec.id}`,
    ),
  cwd: paths.scratchDir,
  known: (id) => state.cachedOptions(id, "model").length > 0,
  learned: (id, category, choices) => {
    if (state.setCachedOptions(id, category, choices)) hub.emit("agentsChanged");
  },
});
agents.onChange = () => {
  hub.emit("agentsChanged");
  fireAndForget("agents", probe.missing(), "read agent models");
};
// a sign-out spawns the adapter on its own, with no session and no worktree: in the scratch
// directory, the same as a probe
const accounts = new AgentAccounts({
  require: (id) => agents.require(id),
  connect: async (app, spec) =>
    spawnAcp(
      app,
      agents.launch(spec, await prepareLaunch(paths.scratchDir, spec)),
      paths.scratchDir,
      `auth:${spec.id}`,
    ),
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
  remote,
  grant: previewGrant(token),
});
const worktrees = new WorktreeService({ state, hub, runtime, paths, agents });
// before the server: its agentStatus listener has to run ahead of the one that broadcasts the rows
const turns = new TurnService({
  state,
  hub,
  transcript: (id) => runtime.agentFor(id)?.transcript() ?? [],
  summarize: makeRecapper(runtime, agents, state),
  hold: (id, tag) => runtime.hold(id, tag),
  release: (id, tag) => runtime.release(id, tag),
});
const files = new FileService(state, runtime, (id) => worktrees.readable(id));
const design = new DesignService((id) => worktrees.readable(id));
const routes = new RouteService({ state, hub, readable: (id) => worktrees.readable(id) });
const exec = new ExecService({ state, runtime });
// after the turn service: its verdict follows the turnSettled the turn service emits
new LandingService({
  state,
  hub,
  worktrees,
  transcript: (id) => runtime.agentFor(id)?.transcript() ?? [],
  check: (id, command) => exec.exec(id, command, CHECK_TOOL),
  judge: makeLander(runtime, agents, state),
});
const refs = new RefSearch({ state });
const chats = new ChatSearch({
  state,
  live: (id) => runtime.agentFor(id)?.transcript(),
  transcriptPath: (id) => transcriptPathFor(paths.transcriptsDir, id),
  archivedChats: (repoId) => worktrees.archivedChats(repoId),
});
const prs = new PrService({ state, hub, worktrees, view: viewPr });
// toyon opened on its own checkout: what landing there leaves behind for the process serving it
const self = new SelfWatch(SOURCE_ROOT);
await self.start();
const afterLand = new AfterLand({ state, hub, self });
const repos = new RepoRegistry({ state, hub, runtime, worktrees, afterLand, self });
// which worktrees run: the ones being looked at, plus what a turn or a command holds; the rest
// sleep on the clock, or sooner when the OS says memory is short
const idle = new IdlePolicy({
  runtime,
  state,
  hub,
  wake: (id) => repos.touch(id),
  warmSpare: (repoId) => repos.warm(repoId),
});
const themes = new ThemeStore({ get: () => state.theme, set: (p) => state.setTheme(p) }, paths.themesDir);
themes.load();

const { branded, stop: stopServer } = startServer({
  port,
  token,
  shellDist: SHELL_DIST,
  version: pkg.version,
  noteShellOrigin: (origin) => bridge.learnShellOrigin(origin),
  remote,
  services: {
    state,
    hub,
    repos,
    worktrees,
    turns,
    files,
    design,
    routes,
    runtime,
    idle,
    exec,
    refs,
    chats,
    prs,
    themes,
    agents,
    accounts,
    attachments,
    self,
    afterLand,
    restart: () => {
      const can = restartable();
      if (!can.ok) return can.reason;
      fireAndForget("daemon", shutdown("restart", { respawn: true }), "restart");
      return null;
    },
    planTasks: makePlanner(agents),
    folderDialog: folderDialog(),
  },
});

// every origin the shell can be loaded from: the injected bridge accepts commands from, and
// reports to, these only. Behind an edge nothing is loopback, so the public name is the one.
bridge.setShellOrigins([
  ...(remote?.front === "edge"
    ? []
    : [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://toyon.localhost:${port}`,
        ...(branded ? ["http://toyon.localhost"] : []),
        // the Vite dev shell frames the same previews
        `http://127.0.0.1:${SHELL_DEV_PORT}`,
        `http://localhost:${SHELL_DEV_PORT}`,
      ]),
  ...(remote ? [`https://${remote.host}`] : []),
]);

// after the bind, so a second daemon that lost the port never overwrites the first one's pid
writeFileSync(paths.pidFile, `${process.pid}\n`);

const stopLagSampler = startLagSampler();

await repos.boot();
// what was being looked at before the restart comes back on its own
idle.boot();
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

/** where previews live under the public name, for the startup lines */
const previewsAt = (r: NonNullable<typeof remote>) =>
  addressedByPort(r.previews)
    ? `previews at ${r.previews}, ports ${PREVIEW_PORTS.from}-${PREVIEW_PORTS.to}`
    : `previews at ${r.previews}`;

if (remote?.front === "edge") {
  console.log(`Toyon daemon on https://${remote.host}/ behind the edge, ${previewsAt(remote)}`);
  console.log(`         token read from ${paths.tokenFile}; not printed`);
} else {
  const shellUrl = branded
    ? `http://toyon.localhost/#token=${token}`
    : `http://toyon.localhost:${port}/#token=${token}`;
  console.log(`Toyon daemon on ${shellUrl}`);
  console.log(`         (fallback: http://127.0.0.1:${port}/#token=${token})`);
  if (remote) {
    console.log(`         remote: https://${remote.host}/#token=${token}, through a TLS front on this port`);
    console.log(`         ${previewsAt(remote)}`);
    console.log("         the token grants a shell on this machine; keep the link to yourself");
  }
}

// Wait for the dev servers to exit (SIGTERM, then SIGKILL after 3s) before leaving, so the
// detached process groups don't outlive the daemon and squat their ports. Bounded: a stuck exit
// can't hold the terminal hostage.
let shuttingDown = false;
async function shutdown(signal: string, opts: { respawn?: boolean } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("daemon", `${signal}: stopping dev servers`);
  // before the sockets close: what the tabs show now is what the next daemon brings back
  idle.shutdown();
  repos.stopWatchers();
  prs.stop();
  stopLagSampler();
  stopServer();
  // the visits still waiting on their coalesced write; a clean stop should not lose them
  routes.flush();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([runtime.shutdown(), deadline]);
  // a crash leaves the file behind on purpose: `toyon stop` checks the pid is alive before trusting it
  rmSync(paths.pidFile, { force: true });
  if (opts.respawn) {
    // last, and after a beat: the replacement binds this port and does not retry, so it must not
    // be racing a listener that is still on its way down
    await Bun.sleep(250);
    log.info("daemon", "starting the replacement");
    respawn(paths.logFile);
  }
  process.exit(0);
}
process.on("SIGINT", () => fireAndForget("daemon", shutdown("SIGINT"), "shutdown"));
process.on("SIGTERM", () => fireAndForget("daemon", shutdown("SIGTERM"), "shutdown"));
