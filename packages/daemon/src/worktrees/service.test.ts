import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeFactories } from "../../test/helpers/fakes.ts";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { transcriptPathFor } from "../agent/session.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { git } from "../git/exec.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { WorktreeService } from "./service.ts";

// Real git in a throwaway repo; fake agent/procs/proxy so nothing is spawned and no SDK is called.

type World = ReturnType<typeof world>;
function world() {
  const t = tmpRepo();
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const f = fakeFactories();
  const runtime = new RuntimeRegistry({ hub, state, paths: t.paths, bridgeScript: () => "", ...f.factories });
  const worktrees = new WorktreeService({ state, hub, runtime, paths: t.paths, namer: async () => null });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees });
  return { ...t, state, hub, runtime, worktrees, repos, ...f };
}

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(async () => {
  await w.runtime.shutdown();
  w.repos.stopWatchers();
  w.cleanup();
});

// a repo with no package.json detects as needsSetup; flip it so procs/spares behave as confirmed
async function registered(): Promise<string> {
  const repo = await w.repos.register(w.repo);
  repo.needsSetup = false;
  repo.config = { procs: { web: "true" } };
  w.state.save();
  return repo.id;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("register", () => {
  test("creates the main pseudo-worktree with an agent and running procs", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(main.repoId).toBe(repoId);
    expect(w.agents.get(main.id)).toBeDefined();
    // needsSetup was true at register time: no procs until the config card is confirmed
    expect(w.procs.get(main.id)?.started).toEqual([]);
  });
});

describe("create / remove", () => {
  test("create adds a git worktree on an toyon/ branch and the agent receives the prompt", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "make the header sticky");
    expect(wt.kind).toBe("worktree");
    expect(wt.branch.startsWith("toyon/make-the-header-sticky")).toBe(true);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(w.agents.get(wt.id)?.sent[0]?.text).toBe("make the header sticky");
    await settle();
    expect(w.procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["web"]);
  });

  test("remove stops the agent and procs, deletes the directory, transcript and state row", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, wt.id), "{}\n");
    await w.worktrees.remove(wt.id);
    expect(w.agents.get(wt.id)?.stops).toBe(1);
    expect(w.procs.get(wt.id)?.stopped).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(transcriptPathFor(w.paths.transcriptsDir, wt.id))).toBe(false);
    expect(w.state.worktree(wt.id)).toBeUndefined();
    expect(w.runtime.get(wt.id)).toBeUndefined();
  });

  test("main cannot be removed", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    await w.worktrees.remove(main.id);
    expect(w.state.worktree(main.id)).toBeDefined();
  });
});

describe("spare pool", () => {
  test("create claims a ready spare, and the task's agent IS the spare's agent", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(spare).toBeDefined();
    const spareAgent = w.agents.get(spare.id)!;
    const wt = await w.worktrees.create(repoId, "use the spare");
    expect(wt.id).toBe(spare.id);
    expect(wt.kind).toBe("worktree");
    expect((await git(wt.path, "branch", "--show-current")).out).toBe(wt.branch);
    expect(spareAgent.sent[0]?.text).toBe("use the spare");
    expect(w.runtime.get(wt.id)?.agent).toBe(spareAgent);
  });

  test("the spare's statuses row is hidden until claimed", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    expect((await w.worktrees.statuses()).some((s) => s.worktree.kind === "spare")).toBe(false);
  });
});

describe("confirmConfig", () => {
  test("restarts procs but keeps the same agent object", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    const agent = w.runtime.get(wt.id)!.agent;
    const procsBefore = w.procs.get(wt.id)!;
    w.repos.confirmConfig(repoId, { procs: { web: "true", api: "true" } });
    await settle();
    expect(w.runtime.get(wt.id)!.agent).toBe(agent);
    expect(procsBefore.stopped).toBe(true);
    expect(
      w.procs
        .get(wt.id)!
        .started.map((p) => p.name)
        .sort(),
    ).toEqual(["api", "web"]);
  });
});

describe("landing", () => {
  test("commit then merge lands on main, marks landed, and offers the worktree for cleanup", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    const { result, removeIds } = await w.worktrees.merge(wt.id);
    expect(result.ok).toBe(true);
    expect(removeIds).toEqual([wt.id]);
    expect(existsSync(join(w.repo, "feature.txt"))).toBe(true);
    expect(w.state.worktree(wt.id)?.landed).toBe(true);
    // new work clears the badge through gitStatus
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBe(false);
  });

  test("merge refuses uncommitted work and main", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "f.txt"), "x\n");
    expect((await w.worktrees.merge(wt.id)).result.ok).toBe(false);
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    await expect(w.worktrees.merge(main.id)).rejects.toBeInstanceOf(UserError);
  });

  test("commit with an empty message is a UserError", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    await expect(w.worktrees.commit(wt.id, "  ")).rejects.toBeInstanceOf(UserError);
  });
});

describe("combine", () => {
  test("conflicting branches roll back the graft worktree and branch", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    writeFileSync(join(a.path, "README.md"), "from a\n");
    sh(a.path, "git", "commit", "-qam", "a");
    writeFileSync(join(b.path, "README.md"), "from b\n");
    sh(b.path, "git", "commit", "-qam", "b");
    await expect(w.worktrees.combine([a.id, b.id])).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktrees.some((x) => x.kind === "combined")).toBe(false);
    expect((await git(w.repo, "branch", "--list", "toyon/alpha+beta")).out).toBe("");
  });

  test("clean branches graft into a combined worktree", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    writeFileSync(join(a.path, "a.txt"), "a\n");
    sh(a.path, "git", "add", "-A");
    sh(a.path, "git", "commit", "-qm", "a");
    writeFileSync(join(b.path, "b.txt"), "b\n");
    sh(b.path, "git", "add", "-A");
    sh(b.path, "git", "commit", "-qm", "b");
    const g = await w.worktrees.combine([a.id, b.id]);
    expect(g.kind).toBe("combined");
    expect(g.sources).toEqual([a.id, b.id]);
    expect(existsSync(join(g.path, "a.txt")) && existsSync(join(g.path, "b.txt"))).toBe(true);
  });
});

describe("boot", () => {
  test("prunes worktrees whose directory is gone and keeps one spare", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    await w.worktrees.spare.ensure(repoId);
    // a second spare row as an older daemon might have left behind
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    w.state.addWorktree({ ...spare, id: "stale-spare", path: `${spare.path}-gone`, proxyPort: 1 });
    // simulate a daemon restart: fresh services over the same state file
    await w.runtime.shutdown();
    sh(w.repo, "git", "worktree", "remove", "--force", wt.path);
    const state2 = new StateStore(w.paths);
    const hub2 = new Hub();
    const f2 = fakeFactories();
    const runtime2 = new RuntimeRegistry({
      hub: hub2,
      state: state2,
      paths: w.paths,
      bridgeScript: () => "",
      ...f2.factories,
    });
    const worktrees2 = new WorktreeService({
      state: state2,
      hub: hub2,
      runtime: runtime2,
      paths: w.paths,
      namer: async () => null,
    });
    const repos2 = new RepoRegistry({ state: state2, hub: hub2, runtime: runtime2, worktrees: worktrees2 });
    await repos2.boot();
    await settle();
    expect(state2.worktree(wt.id)).toBeUndefined();
    expect(state2.worktree("stale-spare")).toBeUndefined();
    expect(state2.worktrees.filter((x) => x.kind === "spare").length).toBe(1);
    expect(runtime2.get(state2.worktrees.find((x) => x.kind === "main")!.id)).toBeDefined();
    await runtime2.shutdown();
    repos2.stopWatchers();
  });
});
