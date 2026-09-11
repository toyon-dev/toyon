import { afterEach, describe, expect, test } from "bun:test";
import { type RepoInfo, SHELL_STREAM, type WorktreeInfo } from "@toyon/shared";
import { fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { procUrlEnv, RuntimeRegistry, terminalEnv } from "./registry.ts";

const repo: RepoInfo = {
  id: "r",
  path: "/nowhere",
  name: "x",
  defaultBranch: "main",
  config: { procs: { api: "true", web: "true" } },
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
        procs: { api: "true", web: "true", worker: "true" },
        profiles: {
          full: {
            procs: ["api", "web"],
            env: {
              VITE_BACKEND_URL: "$API_URL",
              MODE: "local",
              DATABASE_URL: "postgres://localhost/app_$TOYON_WORKTREE",
            },
          },
          fe: { procs: ["web"], env: { VITE_ENVIRONMENT: "staging" } },
        },
        defaultProfile: "fe",
      },
    };
    await registry.start({ ...wt, profile: "full" }, profiled);
    const started = procs.get(wt.id)!.started;
    expect(started.map((p) => p.name)).toEqual(["api", "web"]);
    // nothing is up when api starts: the reference stays literal; the worktree id is always there
    expect(started[0]?.env).toEqual({
      VITE_BACKEND_URL: "$API_URL",
      MODE: "local",
      TOYON_WORKTREE: wt.id,
      DATABASE_URL: `postgres://localhost/app_${wt.id}`,
    });
    expect(started[1]?.env.VITE_BACKEND_URL).toBe(started[1]?.env.API_URL);
    expect(started[1]?.env.MODE).toBe("local");
    expect(started[1]?.env.TOYON_WORKTREE).toBe(wt.id);
    expect(registry.get(wt.id)?.previewName).toBe("web");

    await registry.stopProcs(wt.id);
    await registry.start(wt, profiled); // no profile on the row → the default
    expect(procs.get(wt.id)!.started.map((p) => p.name)).toEqual(["web"]);
    expect(procs.get(wt.id)!.started[0]?.env).toEqual({ VITE_ENVIRONMENT: "staging", TOYON_WORKTREE: wt.id });
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

  test("terminalEnv keeps the daemon's env minus PORT/FORCE_COLOR and adds TERM + the worktree id", () => {
    const env = terminalEnv({ PATH: "/bin", PORT: "1", FORCE_COLOR: "0", GONE: undefined }, wt, { API_URL: "u" });
    expect(env).toEqual({
      PATH: "/bin",
      API_URL: "u",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TOYON_WORKTREE: "w1",
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
