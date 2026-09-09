import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
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
  const agents = fakeAgents();
  const runtime = new RuntimeRegistry({ hub, state, paths: t.paths, agents, bridgeScript: () => "", ...f.factories });
  const worktrees = new WorktreeService({ state, hub, runtime, paths: t.paths, agents, namer: async () => null });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees });
  return { ...t, state, hub, runtime, worktrees, repos, registry: agents, ...f };
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
    expect(wt.linkPath).toBeUndefined(); // the directory already carries the title
    expect(w.agents.get(wt.id)?.sent[0]?.text).toBe("make the header sticky");
    expect(wt.agent).toBe("claude");
    await settle();
    expect(w.procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["web"]);
  });

  test("gitignored local config is copied in, and an existing file is left alone", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".dev.vars"), "AUTH_SECRET=frombase\n");
    writeFileSync(join(w.repo, ".env"), "API=base\n");
    const wt = await w.worktrees.create(repoId, "needs secrets");
    await settle();
    expect(readFileSync(join(wt.path, ".dev.vars"), "utf8")).toBe("AUTH_SECRET=frombase\n");
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("API=base\n");
    // a file the worktree already carries is never overwritten
    writeFileSync(join(wt.path, ".env"), "API=mine\n");
    await w.worktrees.setupAndStart(wt, w.state.repo(wt.repoId)!, w.repo);
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("API=mine\n");
  });

  test("create stamps the requested agent, else the daemon default; unknown ids are UserErrors", async () => {
    const repoId = await registered();
    expect((await w.worktrees.create(repoId, "a", { agent: "codex" })).agent).toBe("codex");
    w.state.setDefaultAgent("codex");
    expect((await w.worktrees.create(repoId, "b")).agent).toBe("codex");
    await expect(w.worktrees.create(repoId, "c", { agent: "nope" })).rejects.toBeInstanceOf(UserError);
  });

  test("remove stops the agent and procs, deletes the directory, transcript and state row", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, wt.id), "{}\n");
    await w.worktrees.remove(wt.id);
    expect(w.agents.get(wt.id)?.closes).toBe(1);
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
    // the spare had no agent; the task's choice is stamped before its first prompt
    expect(wt.agent).toBe("claude");
  });

  test("a claimed spare keeps its directory but gets a title-named link that follows renames and removal", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const wt = await w.worktrees.create(repoId, "use the spare");
    expect(wt.path.includes("wt-")).toBe(true);
    const first = wt.linkPath!;
    expect(first).toBe(join(dirname(wt.path), wt.title));
    expect(readlinkSync(first)).toBe(wt.path);
    await w.worktrees.rename(wt.id, "Better Name");
    expect(wt.title).toBe("better-name");
    expect(lstatSync(first, { throwIfNoEntry: false })).toBeUndefined();
    expect(wt.linkPath).toBe(join(dirname(wt.path), "better-name"));
    expect(readlinkSync(wt.linkPath!)).toBe(wt.path);
    const link = wt.linkPath!;
    await w.worktrees.remove(wt.id);
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("worktrees sharing a title link by branch tail, so links never collide", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "first task");
    const b = await w.worktrees.create(repoId, "second task");
    await w.worktrees.rename(a.id, "same");
    await w.worktrees.rename(b.id, "same");
    expect([a.title, b.title]).toEqual(["same", "same"]);
    expect(b.branch).toBe("toyon/same-2");
    expect(a.linkPath).toBe(join(dirname(a.path), "same"));
    expect(b.linkPath).toBe(join(dirname(b.path), "same-2"));
    expect(readlinkSync(b.linkPath!)).toBe(b.path);
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

describe("profiles", () => {
  const profiled = {
    procs: { api: "true", web: "true" },
    profiles: { full: { procs: ["api", "web"] }, fe: { procs: ["web"] } },
    defaultProfile: "fe",
  };
  async function registeredWithProfiles(): Promise<string> {
    const repoId = await registered();
    w.state.requireRepo(repoId).config = profiled;
    w.state.save();
    return repoId;
  }
  const names = (id: string) => w.procs.get(id)!.started.map((p) => p.name);

  test("create runs the requested profile; a claimed spare restarts under it and keeps its agent", async () => {
    const repoId = await registeredWithProfiles();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(names(spare.id)).toEqual(["web"]); // warmed under the default
    const spareProcs = w.procs.get(spare.id)!;
    const spareAgent = w.agents.get(spare.id)!;
    const wt = await w.worktrees.create(repoId, "full stack task", { profile: "full" });
    await settle();
    expect(wt.id).toBe(spare.id);
    expect(wt.profile).toBe("full");
    expect(spareProcs.stopped).toBe(true);
    expect(names(wt.id)).toEqual(["api", "web"]);
    expect(w.runtime.get(wt.id)?.agent).toBe(spareAgent);
    expect(spareAgent.sent[0]?.text).toBe("full stack task");
    // the default profile claims without a restart
    await settle();
    const wt2 = await w.worktrees.create(repoId, "fe task");
    await settle();
    expect(wt2.profile).toBeUndefined();
    expect(w.procs.get(wt2.id)!.stopped).toBe(false);
  });

  test("an unknown profile is a UserError before anything is created", async () => {
    const repoId = await registeredWithProfiles();
    const before = w.state.worktrees.length;
    await expect(w.worktrees.create(repoId, "x", { profile: "nope" })).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktrees.length).toBe(before);
    const wt = await w.worktrees.create(repoId, "x");
    expect(() => w.worktrees.setProfile(wt.id, "nope")).toThrow(UserError);
  });

  test("setProfile restarts only that worktree's procs and persists the choice", async () => {
    const repoId = await registeredWithProfiles();
    const a = await w.worktrees.create(repoId, "a");
    const b = await w.worktrees.create(repoId, "b");
    await settle();
    const aProcs = w.procs.get(a.id)!;
    const bProcs = w.procs.get(b.id)!;
    const agent = w.runtime.get(a.id)!.agent;
    w.worktrees.setProfile(a.id, "full");
    await settle();
    expect(a.profile).toBe("full");
    expect(aProcs.stopped).toBe(true);
    expect(names(a.id)).toEqual(["api", "web"]);
    expect(bProcs.stopped).toBe(false);
    expect(w.runtime.get(a.id)!.agent).toBe(agent);
    expect(w.state.worktree(a.id)?.profile).toBe("full");
    // same profile again: nothing happens
    const after = w.procs.get(a.id)!;
    w.worktrees.setProfile(a.id, "full");
    await settle();
    expect(w.procs.get(a.id)).toBe(after);
  });

  test("a graft inherits the sources' profile when they agree", async () => {
    const repoId = await registeredWithProfiles();
    const a = await w.worktrees.create(repoId, "a", { profile: "full" });
    const b = await w.worktrees.create(repoId, "b", { profile: "full" });
    await settle();
    sh(a.path, "sh", "-c", "echo a > a.txt && git add -A && git commit -qm a");
    sh(b.path, "sh", "-c", "echo b > b.txt && git add -A && git commit -qm b");
    const g = await w.worktrees.combine([a.id, b.id]);
    expect(g.profile).toBe("full");
  });
});

describe("config reload", () => {
  test("a toyon.json edit becomes the config, restarts the repo's worktrees, and a broken edit is ignored", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    const procsBefore = w.procs.get(wt.id)!;
    let repos = 0;
    w.hub.on("reposChanged", () => repos++);
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ procs: { web: "true", api: "true" } }));
    w.repos.reloadConfig(repoId);
    await settle();
    expect(w.state.requireRepo(repoId).config.procs).toEqual({ web: "true", api: "true" });
    expect(procsBefore.stopped).toBe(true);
    expect(
      w.procs
        .get(wt.id)!
        .started.map((p) => p.name)
        .sort(),
    ).toEqual(["api", "web"]);
    expect(repos).toBe(1);

    const procsNow = w.procs.get(wt.id)!;
    const lines: string[] = [];
    w.hub.on("log", (_id, proc, line) => proc === "config" && lines.push(line));
    writeFileSync(join(w.repo, "toyon.json"), "{ broken");
    w.repos.reloadConfig(repoId);
    await settle();
    expect(w.state.requireRepo(repoId).config.procs).toEqual({ web: "true", api: "true" });
    expect(w.procs.get(wt.id)).toBe(procsNow);
    expect(lines[0]).toMatch(/not valid JSON/);
    expect(repos).toBe(1);
  });

  test("boot picks up a toyon.json written while the daemon was down", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ procs: { api: "true" } }));
    // a second registry over the same state, as a restart would build
    const again = new RepoRegistry({ state: w.state, hub: w.hub, runtime: w.runtime, worktrees: w.worktrees });
    await again.boot();
    again.stopWatchers();
    expect(w.state.requireRepo(repoId).config.procs).toEqual({ api: "true" });
    expect(w.state.requireRepo(repoId).needsSetup).toBe(false);
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
      agents: w.registry,
      bridgeScript: () => "",
      ...f2.factories,
    });
    const worktrees2 = new WorktreeService({
      state: state2,
      hub: hub2,
      runtime: runtime2,
      paths: w.paths,
      agents: w.registry,
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

// The rail rings a worktree whose turn ended while nobody was looking. Green alone cannot separate
// "just finished" from "untouched for a week", and the ring is what closes that gap.
describe("unseen", () => {
  const unseenOf = async (id: string) => (await w.worktrees.statuses()).find((x) => x.worktree.id === id)?.unseen;

  test("a worktree nothing has run in is not unseen", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(await unseenOf(main.id)).toBeUndefined();
  });

  test("a turn ending marks it unseen, and marking it seen clears it", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "working");
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBe(true);
    w.worktrees.markSeen(main.id);
    expect(await unseenOf(main.id)).toBeUndefined();
  });

  test("a turn that ends after you looked rings it again", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "working");
    w.hub.emit("agentStatus", main.id, "idle");
    w.worktrees.markSeen(main.id);
    // the clock is coarse enough that a second turn inside the same millisecond would look seen
    w.state.worktree(main.id)!.seenAt = Date.now() - 1_000;
    w.hub.emit("agentStatus", main.id, "working");
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBe(true);
  });

  test("blocked on a person also counts as a turn ending", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "waiting");
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBe(true);
  });

  // a session reports idle when it is born; that is not a finished turn
  test("idle without a turn before it does not ring", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBeUndefined();
  });
});
