import { afterEach, describe, expect, test } from "bun:test";
import type { RepoInfo, WorktreeInfo } from "@orchardist/shared";
import { fakeFactories } from "../../test/helpers/fakes.ts";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { RuntimeRegistry } from "./registry.ts";

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
  branch: "orchard/w1",
  kind: "worktree",
  proxyPort: 1,
  title: "w1",
  createdAt: 0,
};

let cleanup = () => {};
afterEach(() => cleanup());

function make() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths, { repos: [repo], worktrees: [wt], sessions: {} });
  const hub = new Hub();
  const f = fakeFactories();
  const registry = new RuntimeRegistry({ hub, state, paths: t.paths, bridgeScript: () => "", ...f.factories });
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
    expect(agents.get(wt.id)?.stops).toBe(1);
    expect(procs.get(wt.id)?.stopped).toBe(true);
    expect(proxies.get(wt.id)?.stopped).toBe(true);
    expect(registry.get(wt.id)).toBeUndefined();
  });

  test("stopProcs() keeps the agent; the next start() rebuilds procs around it", async () => {
    const { registry, agents, procs } = make();
    await registry.start(wt, repo);
    const a = registry.get(wt.id)!.agent;
    await registry.stopProcs(wt.id);
    expect(agents.get(wt.id)?.stops).toBe(0);
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

  test("previewTarget() is the running preview proc", async () => {
    const { registry } = make();
    await registry.start(wt, repo);
    const t = registry.previewTarget(wt.id);
    expect(t?.host).toBe("127.0.0.1");
    expect(registry.previewTarget("nope")).toBeNull();
  });
});
