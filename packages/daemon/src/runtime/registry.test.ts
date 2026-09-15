import { afterEach, describe, expect, test } from "bun:test";
import { LOGIN_STREAM, type RepoInfo, SHELL_STREAM, type WorktreeInfo } from "@toyon/shared";
import { fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { procUrlEnv, RuntimeRegistry, terminalEnv, worktreeEnv } from "./registry.ts";
import type { WorktreeProcs } from "./supervisor.ts";

const repo: RepoInfo = {
  id: "r",
  path: "/nowhere",
  name: "x",
  defaultBranch: "main",
  config: { run: { api: "true", web: "true" } },
  configFile: ".toyon/settings.json",
  needsSetup: false,
};
const wt: WorktreeInfo = {
  id: "w1",
  repoId: "r",
  path: "/nowhere/w1",
  branch: "toyon/w1",
  kind: "worktree",
  proxyPort: 1,
  title: "w1",
  createdAt: 0,
};
const spare: WorktreeInfo = { ...wt, id: "s1", path: "/nowhere/s1", branch: "spare-s1", kind: "spare", proxyPort: 2 };

let cleanup = () => {};
afterEach(() => cleanup());

function make() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths, { repos: [repo], worktrees: [wt, spare], sessions: {} });
  const hub = new Hub();
  const f = fakeFactories();
  const agents = fakeAgents(t.paths.agentsDir);
  const registry = new RuntimeRegistry({ hub, state, paths: t.paths, agents, bridgeScript: () => "", ...f.factories });
  return { state, hub, registry, ...f };
}

describe("RuntimeRegistry", () => {
  test("ensureAgent is idempotent and start() reuses it", async () => {
    const { registry, agents } = make();
    const a = registry.ensureAgent(wt).agent;
    expect(registry.ensureAgent(wt).agent).toBe(a);
    await registry.start(wt, repo);
    expect(registry.get(wt.id)?.agent).toBe(a);
    expect(agents.size).toBe(1);
  });

  test("start() runs non-preview procs first, then the preview; a second start is a no-op", async () => {
    const { registry, procs, hub } = make();
    let changed = 0;
    hub.on("worktreesChanged", () => changed++);
    await registry.start(wt, repo);
    expect(procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["api", "web"]);
    expect(changed).toBe(1);
    await registry.start(wt, repo);
    expect(procs.size).toBe(1);
  });

  test("an unconfirmed repo gets an agent and a proxy but no procs", async () => {
    const { registry, procs, proxies } = make();
    await registry.start(wt, { ...repo, needsSetup: true });
    expect(procs.get(wt.id)?.started).toEqual([]);
    expect(proxies.get(wt.id)).toBeDefined();
  });

  test("stop() stops agent, procs and proxy and forgets the runtime", async () => {
    const { registry, agents, procs, proxies } = make();
    await registry.start(wt, repo);
    await registry.stop(wt.id);
    expect(agents.get(wt.id)?.closes).toBe(1);
    expect(procs.get(wt.id)?.stopped).toBe(true);
    expect(proxies.get(wt.id)?.stopped).toBe(true);
    expect(registry.get(wt.id)).toBeUndefined();
  });

  test("stopProcs() keeps the agent; the next start() rebuilds procs around it", async () => {
    const { registry, agents, procs } = make();
    await registry.start(wt, repo);
    const a = registry.get(wt.id)!.agent;
    await registry.stopProcs(wt.id);
    expect(agents.get(wt.id)?.closes).toBe(0);
    expect(registry.get(wt.id)?.procs).toBeNull();
    await registry.start(wt, repo);
    expect(registry.get(wt.id)?.agent).toBe(a);
    expect(procs.get(wt.id)?.started.length).toBe(2);
  });

  test("start() for a worktree no longer in state does nothing", async () => {
    const { registry, state, procs } = make();
    state.removeWorktree(wt.id);
    await registry.start(wt, repo);
    expect(registry.get(wt.id)).toBeUndefined();
    expect(procs.size).toBe(0);
  });

  test("a profile narrows and orders the procs, and its env reaches every proc with $API_URL expanded", async () => {
    const { registry, procs } = make();
    const profiled: RepoInfo = {
      ...repo,
      config: {
        run: { api: "true", web: "true", worker: "true" },
        profiles: {
          full: {
            run: ["api", "web"],
            env: {
              VITE_BACKEND_URL: "$API_URL",
              MODE: "local",
              DATABASE_URL: "postgres://localhost/app_$TOYON_WORKTREE",
            },
          },
          fe: { run: ["web"], env: { VITE_ENVIRONMENT: "staging" } },
        },
        defaultProfile: "fe",
      },
    };
    await registry.start({ ...wt, profile: "full" }, profiled);
    const started = procs.get(wt.id)!.started;
    expect(started.map((p) => p.name)).toEqual(["api", "web"]);
    // nothing is up when api starts: the reference stays literal; the worktree's own are always there
    expect(started[0]?.env).toEqual({
      VITE_BACKEND_URL: "$API_URL",
      MODE: "local",
      TOYON_WORKTREE: wt.id,
      TOYON_ROOT: repo.path,
      DATABASE_URL: `postgres://localhost/app_${wt.id}`,
    });
    expect(started[1]?.env.VITE_BACKEND_URL).toBe(started[1]?.env.API_URL);
    expect(started[1]?.env.MODE).toBe("local");
    expect(started[1]?.env.TOYON_WORKTREE).toBe(wt.id);
    expect(registry.get(wt.id)?.previewName).toBe("web");

    await registry.stopProcs(wt.id);
    await registry.start(wt, profiled); // no profile on the row → the default
    expect(procs.get(wt.id)!.started.map((p) => p.name)).toEqual(["web"]);
    expect(procs.get(wt.id)!.started[0]?.env).toEqual({
      VITE_ENVIRONMENT: "staging",
      TOYON_WORKTREE: wt.id,
      TOYON_ROOT: repo.path,
    });
  });

  test("previewTarget() is the running preview proc", async () => {
    const { registry } = make();
    await registry.start(wt, repo);
    const t = registry.previewTarget(wt.id);
    expect(t?.host).toBe("127.0.0.1");
    expect(registry.previewTarget("nope")).toBeNull();
  });
});

describe("terminal env", () => {
  test("procUrlEnv names every non-preview proc and doubles api as API_URL", () => {
    const st = (name: string, port: number) => ({ name, command: "x", port, status: "running" as const });
    expect(procUrlEnv([st("api", 1), st("job-runner", 2), st("web", 3)], "web")).toEqual({
      API_URL: "http://127.0.0.1:1",
      VITE_API_URL: "http://127.0.0.1:1",
      JOB_RUNNER_URL: "http://127.0.0.1:2",
      VITE_JOB_RUNNER_URL: "http://127.0.0.1:2",
    });
  });

  test("terminalEnv keeps the daemon's env minus PORT/FORCE_COLOR and adds TERM + the worktree's own", () => {
    const env = terminalEnv({ PATH: "/bin", PORT: "1", FORCE_COLOR: "0", GONE: undefined }, worktreeEnv(wt, repo), {
      API_URL: "u",
    });
    expect(env).toEqual({
      PATH: "/bin",
      API_URL: "u",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TOYON_WORKTREE: "w1",
      TOYON_ROOT: "/nowhere",
    });
  });
});

describe("RuntimeRegistry terminals", () => {
  test("openTerminal spawns once, in the worktree, with the sibling URLs", async () => {
    const { registry, terminals } = make();
    await registry.start(wt, repo);
    const first = registry.openTerminal(wt.id, SHELL_STREAM, 80, 24);
    expect(first).toEqual({ snapshot: "", alive: true });
    const spawned = terminals.get(wt.id)!;
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.opts.cwd).toBe(wt.path);
    expect(spawned[0]!.opts.env.API_URL).toBe("http://127.0.0.1:40001");
    expect(spawned[0]!.opts.env.TERM).toBe("xterm-256color");
    expect(spawned[0]!.opts.env.TOYON_WORKTREE).toBe(wt.id);
    expect(spawned[0]!.opts.env.TOYON_ROOT).toBe(repo.path);
    spawned[0]!.emit("$ ");
    expect(registry.openTerminal(wt.id, SHELL_STREAM, 80, 24)).toEqual({ snapshot: "$ ", alive: true });
    expect(spawned.length).toBe(1);
  });

  test("a terminal opens before the procs are up, and a different size on reopen resizes", () => {
    const { registry, terminals } = make();
    registry.openTerminal(wt.id, SHELL_STREAM, 80, 24);
    const t = terminals.get(wt.id)![0]!;
    expect(t.opts.env.API_URL).toBeUndefined();
    expect(t.resizes).toEqual([]);
    registry.openTerminal(wt.id, SHELL_STREAM, 120, 40);
    expect(t.resizes).toEqual([[120, 40]]);
  });

  test("a login is its own stream: a failed one stays and runs again, a clean exit tells the agent", async () => {
    const { registry, terminals, agents } = make();
    registry.startLogin(wt.id, { command: "/bin/login", args: ["--now"], env: { NO_BROWSER: "1" } });
    const first = terminals.get(wt.id)![0]!;
    expect(first.opts.cwd).toBe(wt.path);
    expect(first.opts.env.NO_BROWSER).toBe("1");
    expect(first.opts.env.TOYON_WORKTREE).toBe(wt.id);
    first.emit("paste code: ");
    expect(registry.openTerminal(wt.id, LOGIN_STREAM, 80, 24)).toEqual({ snapshot: "paste code: ", alive: true });
    first.exit(1);
    expect(agents.get(wt.id)?.logins).toBe(0);
    expect(registry.get(wt.id)?.login).not.toBeNull();
    await registry.restartStream(wt.id, LOGIN_STREAM);
    const second = terminals.get(wt.id)![1]!;
    expect(second.opts.args).toEqual(["--now"]);
    second.exit(0);
    expect(agents.get(wt.id)?.logins).toBe(1);
    expect(registry.get(wt.id)?.login).toBeNull();
    expect(registry.openTerminal(wt.id, LOGIN_STREAM, 80, 24)).toEqual({ snapshot: "", alive: false });
  });

  test("a login that was replaced or stopped says nothing about credentials", async () => {
    const { registry, terminals, agents } = make();
    const run = { command: "/bin/login", args: [], env: {} };
    registry.startLogin(wt.id, run);
    registry.startLogin(wt.id, run);
    terminals.get(wt.id)![0]!.exit(0);
    expect(agents.get(wt.id)?.logins).toBe(0);
    await registry.stop(wt.id);
    expect(agents.get(wt.id)?.logins).toBe(0);
  });

  test("output and exit reach the hub; input after the exit is dropped; the next open respawns", () => {
    const { registry, terminals, hub } = make();
    const data: string[] = [];
    const exits: number[] = [];
    hub.on("termData", (id, stream, d) => data.push(`${id}/${stream}:${d}`));
    hub.on("termExit", (_id, _stream, code) => exits.push(code));
    registry.openTerminal(wt.id, SHELL_STREAM, 80, 24);
    const t = terminals.get(wt.id)![0]!;
    registry.terminalInput(wt.id, SHELL_STREAM, "ls\n");
    registry.terminalResize(wt.id, SHELL_STREAM, 90, 30);
    t.emit("ls\nfile\n");
    expect(t.writes).toEqual(["ls\n"]);
    expect(t.resizes).toEqual([[90, 30]]);
    expect(data).toEqual(["w1/shell:ls\nfile\n"]);
    t.exit(1);
    expect(exits).toEqual([1]);
    registry.terminalInput(wt.id, SHELL_STREAM, "echo\n");
    expect(t.writes).toEqual(["ls\n"]);
    expect(registry.openTerminal(wt.id, SHELL_STREAM, 80, 24)).toEqual({ snapshot: "", alive: true });
    expect(terminals.get(wt.id)!.length).toBe(2);
  });

  test("killTerminal and stop() kill the shell; stopProcs() leaves it running", async () => {
    const { registry, terminals } = make();
    await registry.start(wt, repo);
    registry.openTerminal(wt.id, SHELL_STREAM, 80, 24);
    const t = terminals.get(wt.id)![0]!;
    await registry.stopProcs(wt.id);
    expect(t.kills).toBe(0);
    expect(t.alive).toBe(true);
    await registry.restartStream(wt.id, SHELL_STREAM);
    expect(t.kills).toBe(1);
    registry.openTerminal(wt.id, SHELL_STREAM, 80, 24);
    const t2 = terminals.get(wt.id)![1]!;
    await registry.stop(wt.id);
    expect(t2.kills).toBe(1);
    expect(t2.alive).toBe(false);
  });

  test("input with no terminal is a no-op; a spare has no terminal", async () => {
    const { registry } = make();
    registry.terminalInput(wt.id, SHELL_STREAM, "x");
    registry.terminalResize(wt.id, SHELL_STREAM, 1, 1);
    await registry.restartStream(wt.id, SHELL_STREAM);
    expect(() => registry.openTerminal(spare.id, SHELL_STREAM, 80, 24)).toThrow(UserError);
    expect(() => registry.openTerminal("nope", SHELL_STREAM, 80, 24)).toThrow(UserError);
  });
});

describe("RuntimeRegistry sleep and wake", () => {
  test("sleep stops the procs and keeps the proxy, its port, the agent and the shell", async () => {
    const { registry, agents, procs, proxies, terminals, hub } = make();
    let changed = 0;
    hub.on("worktreesChanged", () => changed++);
    await registry.start(wt, repo);
    registry.openTerminal(wt.id, SHELL_STREAM, 80, 24);
    const proxy = proxies.get(wt.id)!;
    await registry.sleep(wt.id);
    expect(procs.get(wt.id)?.asleep).toBe(true);
    expect(
      procs
        .get(wt.id)
        ?.states()
        .map((p) => p.status),
    ).toEqual(["asleep", "asleep"]);
    expect(registry.isAsleep(wt.id)).toBe(true);
    expect(registry.previewTarget(wt.id)).toBeNull();
    expect(proxy.stopped).toBe(false);
    expect(registry.get(wt.id)?.proxy).toBe(proxy);
    expect(agents.get(wt.id)?.closes).toBe(0);
    expect(terminals.get(wt.id)![0]!.alive).toBe(true);
    expect(registry.tiers()).toEqual({ awake: 0, asleep: 1 });
    // a second sleep changes nothing and says nothing
    const before = changed;
    await registry.sleep(wt.id);
    expect(changed).toBe(before);
    await registry.wake(wt.id);
    expect(procs.get(wt.id)?.asleep).toBe(false);
    expect(registry.get(wt.id)?.proxy).toBe(proxy);
    expect(registry.get(wt.id)?.procs).toBe(procs.get(wt.id) as unknown as WorktreeProcs);
    expect(registry.tiers()).toEqual({ awake: 1, asleep: 0 });
    expect(registry.awake().map((a) => a.id)).toEqual([wt.id]);
  });

  test("wake starts a cold worktree, and is a no-op while its setup runs", async () => {
    const { registry, procs } = make();
    registry.markSetup(wt.id, true);
    await registry.wake(wt.id);
    expect(registry.get(wt.id)?.procs ?? null).toBeNull();
    registry.markSetup(wt.id, false);
    await registry.wake(wt.id);
    expect(procs.get(wt.id)?.started.length).toBe(2);
    // up already: nothing more happens
    await registry.wake(wt.id);
    expect(procs.size).toBe(1);
    await registry.wake("nope");
  });

  test("a restart asked of an asleep proc's tab wakes the whole set", async () => {
    const { registry, procs } = make();
    await registry.start(wt, repo);
    await registry.sleep(wt.id);
    await registry.restartStream(wt.id, "web");
    expect(procs.get(wt.id)?.restarts).toEqual([]);
    expect(procs.get(wt.id)?.asleep).toBe(false);
    await registry.restartStream(wt.id, "web");
    expect(procs.get(wt.id)?.restarts).toEqual(["web"]);
  });

  test("holds count by tag and stop() forgets them", async () => {
    const { registry, hub } = make();
    const seen: Array<[string, number]> = [];
    hub.on("holdsChanged", (id, n) => seen.push([id, n]));
    registry.hold(wt.id, "turn");
    registry.hold(wt.id, "exec:1");
    registry.hold(wt.id, "turn");
    expect(registry.holdCount(wt.id)).toBe(2);
    registry.release(wt.id, "turn");
    registry.release(wt.id, "turn");
    expect(registry.holdCount(wt.id)).toBe(1);
    expect(seen).toEqual([
      [wt.id, 1],
      [wt.id, 2],
      [wt.id, 2],
      [wt.id, 1],
    ]);
    await registry.stop(wt.id);
    expect(registry.holdCount(wt.id)).toBe(0);
  });

  test("awaitPreview answers once the preview runs, and at once when nothing is coming", async () => {
    const { registry, procs } = make();
    expect(await registry.awaitPreview(wt.id, 1000)).toBeNull();
    await registry.start(wt, repo);
    const fake = procs.get(wt.id)!;
    const t = await registry.awaitPreview(wt.id, 1000);
    expect(t?.port).toBe(fake.states().find((p) => p.name === "web")?.port);
    await registry.sleep(wt.id);
    const t0 = Date.now();
    expect(await registry.awaitPreview(wt.id, 1000)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
