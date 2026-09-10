import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  test("remove stops the agent and procs, deletes the directory, branch, transcript and state row", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    // unmerged work on the branch: the confirm said it would be lost, so the delete is forced
    writeFileSync(join(wt.path, "new.txt"), "x\n");
    sh(wt.path, "git", "add", "new.txt");
    sh(wt.path, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unmerged");
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, wt.id), "{}\n");
    await w.worktrees.remove(wt.id);
    expect(w.agents.get(wt.id)?.closes).toBe(1);
    expect(w.procs.get(wt.id)?.stopped).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(w.repo, "git", "branch", "--list", wt.branch)).toBe("");
    expect(existsSync(transcriptPathFor(w.paths.transcriptsDir, wt.id))).toBe(false);
    expect(w.state.worktree(wt.id)).toBeUndefined();
    expect(w.runtime.get(wt.id)).toBeUndefined();
  });

  test("removing an adopted worktree keeps the person's branch", async () => {
    await registered();
    await settle();
    const wt = await adoptDir(foreignWorktree("theirs", "their-branch"));
    await settle();
    await w.worktrees.remove(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(w.repo, "git", "branch", "--list", "their-branch")).toBe("their-branch");
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
    expect((await w.worktrees.rows()).some((s) => s.worktree?.kind === "spare")).toBe(false);
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

describe("empty tree", () => {
  test("main says whether the tree is empty; a task worktree never does", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    expect((await w.worktrees.gitStatus(main.id))?.empty).toBe(false);
    const wt = await w.worktrees.create(repoId, "task");
    expect((await w.worktrees.gitStatus(wt.id))?.empty).toBeUndefined();
  });

  test("a project made from the picker is empty until something lands in it", async () => {
    const dir = join(dirname(w.repo), "fresh");
    sh(dirname(w.repo), "git", "init", "-q", "-b", "main", dir);
    sh(
      dir,
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "initial commit",
    );
    const repo = await w.repos.register(dir);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    expect((await w.worktrees.gitStatus(main.id))?.empty).toBe(true);
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>\n");
    expect((await w.worktrees.gitStatus(main.id))?.empty).toBeUndefined();
  });
});

describe("redetect at turn end", () => {
  const turnEnd = (id: string) => w.hub.emit("agent", id, 0, { type: "turn-end", stopReason: "end_turn", ts: 0 });

  test("a scaffold that detection recognises becomes the guess, still unconfirmed", async () => {
    const repo = await w.repos.register(w.repo);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    expect(repo.needsSetup).toBe(true);
    let repos = 0;
    w.hub.on("reposChanged", () => repos++);
    writeFileSync(join(w.repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    writeFileSync(join(w.repo, "bun.lock"), "");
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).config).toEqual({
      procs: { web: "bun run dev --port $PORT --strictPort" },
      setup: ["bun install"],
    });
    expect(w.state.requireRepo(repo.id).needsSetup).toBe(true);
    expect(repos).toBe(1);
    // the same tree again says nothing new
    turnEnd(main.id);
    expect(repos).toBe(1);
  });

  test("a toyon.json the agent wrote applies at once, like a hand-written one", async () => {
    const repo = await w.repos.register(w.repo);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ procs: { web: "true" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).needsSetup).toBe(false);
    expect(w.state.requireRepo(repo.id).config.procs).toEqual({ web: "true" });
  });

  test("a confirmed repo keeps its config whatever lands in the tree", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    writeFileSync(join(w.repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repoId).config).toEqual({ procs: { web: "true" } });
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

  test("a conflicted sync says so and leaves the tree as it was", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "README.md"), "theirs\n");
    sh(wt.path, "git", "commit", "-qam", "theirs");
    writeFileSync(join(w.repo, "README.md"), "ours\n");
    sh(w.repo, "git", "commit", "-qam", "ours");
    const { result } = await w.worktrees.sync(wt.id);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("theirs\n");
  });

  test("commit with an empty message is a UserError", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    await expect(w.worktrees.commit(wt.id, "  ")).rejects.toBeInstanceOf(UserError);
  });

  // the rail's badges come from rows(), which caches counts for 10s; a landing op that moves
  // the worktree's own HEAD has to drop that entry and push a frame, or the rail keeps showing the
  // count the person just acted on
  test("sync and commit refresh the badge counts at once and push a worktrees frame", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    let frames = 0;
    w.hub.on("worktreesChanged", () => frames++);
    const row = async () => (await w.worktrees.rows()).find((s) => s.id === wt.id)!;

    sh(w.repo, "git", "commit", "--allow-empty", "-m", "main moves on");
    w.worktrees.invalidateCounts();
    expect((await row()).behind).toBe(1);

    frames = 0;
    expect((await w.worktrees.sync(wt.id)).result.ok).toBe(true);
    expect(frames).toBe(1);
    expect((await row()).behind).toBe(0);
    expect((await row()).ahead).toBe(0);

    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    frames = 0;
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    expect(frames).toBe(1);
    expect((await row()).ahead).toBe(1);
  });
});

describe("open a ref", () => {
  test("a local branch becomes a worktree toyon owns, on that branch, with no prompt sent", async () => {
    const repoId = await registered();
    sh(w.repo, "git", "branch", "feat", "main");
    const wt = await w.worktrees.openRef(repoId, "branch", "feat", { createdBy: "tab" });
    await settle();
    expect(wt).toMatchObject({ kind: "worktree", branch: "feat", title: "feat", createdBy: "tab" });
    expect(wt.from).toEqual({ kind: "branch", ref: "feat" });
    expect(wt.path.startsWith(w.paths.worktreesDir)).toBe(true);
    expect((await git(wt.path, "branch", "--show-current")).out).toBe("feat");
    expect(w.procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["web"]);
    expect(w.agents.get(wt.id)?.sent ?? []).toEqual([]);
    // a branch has one worktree: opening it again says where it already is
    await expect(w.worktrees.openRef(repoId, "branch", "feat")).rejects.toBeInstanceOf(UserError);
  });

  test("a remote branch is opened tracking its remote, and a PR from the remote's refs/pull", async () => {
    const repoId = await registered();
    // a local "origin" with a branch and a PR head that this repo does not have
    const origin = join(dirname(w.repo), "origin.git");
    sh(dirname(w.repo), "git", "clone", "-q", "--bare", w.repo, origin);
    sh(w.repo, "git", "remote", "add", "origin", origin);
    sh(w.repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "theirs");
    sh(w.repo, "git", "push", "-q", "origin", "main:refs/heads/theirs", "main:refs/pull/7/head");
    sh(w.repo, "git", "reset", "-q", "--hard", "HEAD~1");
    sh(w.repo, "git", "fetch", "-q", "origin");

    const remote = await w.worktrees.openRef(repoId, "remote", "theirs");
    expect(remote.from).toEqual({ kind: "remote", ref: "theirs" });
    expect((await git(remote.path, "rev-parse", "--abbrev-ref", "theirs@{u}")).out).toBe("origin/theirs");

    const pr = await w.worktrees.openRef(repoId, "pr", "7", { pr: { title: "Seven", url: "https://x/pull/7" } });
    expect(pr).toMatchObject({ branch: "pr/7", title: "pr-7" });
    expect(pr.from).toEqual({ kind: "pr", ref: "7", pr: { number: 7, title: "Seven", url: "https://x/pull/7" } });
    expect((await git(pr.path, "log", "-1", "--format=%s")).out).toBe("theirs");
    // a review is landed upstream, not here
    await expect(w.worktrees.merge(pr.id)).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.openRef(repoId, "pr", "x")).rejects.toBeInstanceOf(UserError);
  });
});

describe("graft", () => {
  const commitIn = (path: string, file: string) => {
    writeFileSync(join(path, file), `${file}\n`);
    sh(path, "git", "add", "-A");
    sh(path, "git", "commit", "-qm", file);
  };

  test("merges the source into the target, appends its transcript, and removes it", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    commitIn(a.path, "a.txt");
    commitIn(b.path, "b.txt");
    w.agents.get(b.id)!.note({ type: "user-message", text: "in beta", ts: 1 });
    const portBefore = a.proxyPort;
    const { target, grafted } = await w.worktrees.graft(a.id, [b.id]);
    expect(target.id).toBe(a.id);
    expect(grafted).toEqual([b.title]);
    expect(existsSync(join(a.path, "b.txt"))).toBe(true);
    expect(w.state.worktree(b.id)).toBeUndefined();
    expect(existsSync(b.path)).toBe(false);
    expect((await git(w.repo, "branch", "--list", b.branch)).out).toBe("");
    // the target is the same worktree it was: same record, same port, procs never restarted
    expect(w.state.worktree(a.id)?.proxyPort).toBe(portBefore);
    expect(w.state.worktree(a.id)?.kind).toBe("worktree");
    // beta's history is now alpha's, behind a marker saying where it came from
    const recorded = w.agents.get(a.id)!.recorded;
    expect(recorded.map((e) => e.type)).toEqual(["grafted", "user-message"]);
    expect(recorded[0]).toMatchObject({ type: "grafted", title: b.title, branch: b.branch });
  });

  test("a dirty source is refused and nothing is touched", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    commitIn(b.path, "b.txt");
    writeFileSync(join(b.path, "wip.txt"), "not committed\n");
    const head = (await git(a.path, "rev-parse", "HEAD")).out;
    await expect(w.worktrees.graft(a.id, [b.id])).rejects.toThrow(`commit or discard the changes in ${b.title}`);
    expect(w.state.worktree(b.id)).toBeDefined();
    expect((await git(a.path, "rev-parse", "HEAD")).out).toBe(head);
    expect(existsSync(join(b.path, "wip.txt"))).toBe(true);
  });

  test("a conflict aborts the merge and removes nothing", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    writeFileSync(join(a.path, "README.md"), "from a\n");
    sh(a.path, "git", "commit", "-qam", "a");
    writeFileSync(join(b.path, "README.md"), "from b\n");
    sh(b.path, "git", "commit", "-qam", "b");
    await expect(w.worktrees.graft(a.id, [b.id])).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktree(b.id)).toBeDefined();
    expect(existsSync(join(a.path, ".git", "MERGE_HEAD")) || existsSync(join(a.path, "MERGE_HEAD"))).toBe(false);
    expect((await git(a.path, "status", "--porcelain")).out).toBe("");
    expect(readFileSync(join(a.path, "README.md"), "utf8")).toBe("from a\n");
  });

  test("a mid-turn agent, main, and a target among its own sources are refused", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    commitIn(b.path, "b.txt");
    w.agents.get(b.id)!.status = "working";
    await expect(w.worktrees.graft(a.id, [b.id])).rejects.toThrow(/mid-turn/);
    w.agents.get(b.id)!.status = "idle";
    await expect(w.worktrees.graft(main.id, [b.id])).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.graft(a.id, [main.id])).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.graft(a.id, [a.id])).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktree(b.id)).toBeDefined();
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
    // boot starts nothing; opening main is what starts it
    const main = state2.worktrees.find((x) => x.kind === "main")!;
    expect(runtime2.get(main.id)?.procs ?? null).toBeNull();
    repos2.touch(main.id);
    await settle();
    expect(runtime2.get(main.id)?.procs).toBeTruthy();
    await runtime2.shutdown();
    repos2.stopWatchers();
  });

  test("touching one repo warms all of its worktrees and none of another's", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "a");
    const b = await w.worktrees.create(repoId, "b");
    const other = tmpRepo();
    try {
      const otherId = (await w.repos.register(other.repo)).id;
      const otherMain = w.state.worktrees.find((x) => x.repoId === otherId && x.kind === "main")!;
      await settle();
      // restart over the same state: everything comes back cold
      await w.runtime.shutdown();
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
      expect(runtime2.runningCount()).toBe(0);
      repos2.touch(a.id);
      await settle();
      const up = (id: string) => !!runtime2.get(id)?.procs;
      expect([up(a.id), up(b.id), up(otherMain.id)]).toEqual([true, true, false]);
      // a second touch of the same repo is not a second warm
      repos2.touch(b.id);
      await settle();
      expect(up(otherMain.id)).toBe(false);
      await runtime2.shutdown();
      repos2.stopWatchers();
    } finally {
      other.cleanup();
    }
  });
});

// The rail rings a worktree whose turn ended while nobody was looking. Green alone cannot separate
// "just finished" from "untouched for a week", and the ring is what closes that gap.
describe("unseen", () => {
  const unseenOf = async (id: string) => (await w.worktrees.rows()).find((x) => x.id === id)?.unseen;

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

// a worktree someone made in a terminal, which is the whole reason discovery exists
function foreignWorktree(name: string, branch: string): string {
  const dir = join(dirname(w.repo), name);
  sh(w.repo, "git", "worktree", "add", "-q", "-b", branch, dir, "main");
  w.worktrees.invalidateDiscovered();
  return dir;
}

/** the id the row at this directory was pushed with; adopt is addressed by it. A directory that
 * was never a worktree has no row, and an id nothing resolves is what the shell would send then. */
async function foundId(dir: string): Promise<string> {
  w.worktrees.invalidateDiscovered();
  const want = existsSync(dir) ? realpathSync(dir) : dir;
  const row = (await w.worktrees.discovered()).find((r) => realpathSync(r.path) === want);
  return row?.id ?? "nope";
}
const adoptDir = async (dir: string, createdBy?: string) => w.worktrees.adopt(await foundId(dir), createdBy);

describe("discovery", () => {
  test("a worktree made behind toyon's back is discovered", async () => {
    const repoId = await registered();
    await settle(); // the spare warms in the background and must not read as a stray
    const dir = foreignWorktree("outside", "made-elsewhere");

    const rows = await w.worktrees.discovered();
    expect(rows.map((r) => r.name)).toEqual(["made-elsewhere"]);
    expect(rows[0]?.repoId).toBe(repoId);
    expect(rows[0]?.branch).toBe("made-elsewhere");
    expect(existsSync(dir)).toBe(true);
  });

  test("rows() lists toyon's own first, then what it found, with counts on both", async () => {
    const repoId = await registered();
    const task = await w.worktrees.create(repoId, "mine");
    await settle();
    const dir = foreignWorktree("theirs", "their-branch");
    writeFileSync(join(dir, "wip.txt"), "x\n");
    sh(dir, "git", "add", "wip.txt");
    sh(dir, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "theirs");
    writeFileSync(join(dir, "dirty.txt"), "y\n");
    const rows = await w.worktrees.rows();
    const found = rows.at(-1)!;
    expect(rows.slice(0, -1).every((r) => r.worktree)).toBe(true);
    expect(rows.some((r) => r.id === task.id)).toBe(true);
    expect(found.worktree).toBeUndefined();
    expect(found).toMatchObject({ name: "their-branch", branch: "their-branch", procs: [], agent: "idle" });
    expect(found.ahead).toBe(1);
    expect(found.dirty).toBe(1);
  });

  test("toyon's own worktrees never appear, spare included", async () => {
    const repoId = await registered();
    await w.worktrees.create(repoId, "some task");
    await settle();
    w.worktrees.invalidateDiscovered();
    expect(await w.worktrees.discovered()).toEqual([]);
  });

  test("the list is cached until something invalidates it", async () => {
    await registered();
    await settle();
    expect(await w.worktrees.discovered()).toEqual([]);
    const dir = join(dirname(w.repo), "cached");
    sh(w.repo, "git", "worktree", "add", "-q", "-b", "cached-branch", dir, "main");
    // no invalidation: statuses() runs on every proc event and must not re-shell for each one
    expect(await w.worktrees.discovered()).toEqual([]);
    w.worktrees.invalidateDiscovered();
    expect((await w.worktrees.discovered()).map((r) => r.name)).toEqual(["cached-branch"]);
  });
});

describe("adopt", () => {
  test("take-over records it, starts its procs, and drops it from discovered", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("takeover", "take-me");

    const wt = await adoptDir(dir);
    expect(wt.kind).toBe("worktree");
    expect(wt.branch).toBe("take-me");
    expect(wt.title).toBe("take-me");
    expect(wt.proxyPort).toBeGreaterThan(0);
    await settle();

    const rows = await w.worktrees.rows();
    expect(rows.find((s) => s.id === wt.id)?.worktree).toBe(wt);
    expect(rows.every((s) => s.worktree)).toBe(true);
    expect(await w.worktrees.discovered()).toEqual([]);
    expect(w.procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["web"]);
    // take-over is not a task: no prompt goes anywhere
    expect(w.agents.get(wt.id)?.sent ?? []).toEqual([]);
  });

  test("an adopted worktree keeps its branch name: rename refuses rather than moving it under toyon/", async () => {
    await registered();
    await settle();
    const wt = await adoptDir(foreignWorktree("theirs", "their-branch"));
    await expect(w.worktrees.rename(wt.id, "mine now")).rejects.toBeInstanceOf(UserError);
    expect(wt.branch).toBe("their-branch");
    expect(wt.title).toBe("their-branch");
  });

  test("a clean found worktree behind main syncs without take-over; a dirty one is refused untouched", async () => {
    const repoId = await registered();
    await settle();
    const dir = foreignWorktree("behind", "their-branch");
    const id = await foundId(dir);
    writeFileSync(join(w.repo, "newer.txt"), "x\n");
    sh(w.repo, "git", "add", "newer.txt");
    sh(w.repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main moved");
    expect((await w.worktrees.gitStatus(id))?.behind).toBe(1);
    // dirty: refused before anything happens, and not as a conflict
    writeFileSync(join(dir, "wip.txt"), "y\n");
    const dirty = await w.worktrees.sync(id);
    expect(dirty.result.ok).toBe(false);
    expect(dirty.result.conflict).toBeUndefined();
    expect(existsSync(join(dir, "newer.txt"))).toBe(false);
    // clean: main comes in, and the row is still not toyon's
    rmSync(join(dir, "wip.txt"));
    const { result } = await w.worktrees.sync(id);
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "newer.txt"))).toBe(true);
    expect((await w.worktrees.gitStatus(id))?.behind).toBe(0);
    expect(w.state.worktrees.some((x) => x.branch === "their-branch")).toBe(false);
    // main is its own baseline, and a held worktree is someone else's
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    await expect(w.worktrees.sync(main.id)).rejects.toBeInstanceOf(UserError);
    sh(w.repo, "git", "worktree", "lock", "--reason", "claude session (pid 1)", dir);
    w.worktrees.invalidateDiscovered();
    await expect(w.worktrees.sync(await foundId(dir))).rejects.toBeInstanceOf(UserError);
  });

  test("adopting a row toyon already owns, or an id nothing resolves, is a toast", async () => {
    const repoId = await registered();
    const task = await w.worktrees.create(repoId, "mine");
    await expect(w.worktrees.adopt(task.id)).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.adopt("disc-000000000000")).rejects.toBeInstanceOf(UserError);
  });

  test("it does not run the repo's setup commands in a directory someone is using", async () => {
    const repoId = await registered();
    const repo = w.state.requireRepo(repoId);
    repo.config = { ...repo.config, setup: ["touch SETUP_RAN"] };
    w.state.save();
    await settle();
    const dir = foreignWorktree("nosetup", "no-setup");

    const wt = await adoptDir(dir);
    await settle();
    expect(existsSync(join(wt.path, "SETUP_RAN"))).toBe(false);
  });

  test("no stray symlink is planted beside it, on adopt or on the next boot", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("linkless", "editor-pane");

    const wt = await adoptDir(dir);
    await settle();
    expect(wt.linkPath).toBeUndefined();
    // the name refreshLink would otherwise have chosen: <parent>/<branch>
    expect(existsSync(join(dirname(dir), "editor-pane"))).toBe(false);

    // the constructor re-links every worktree at boot, so this has to survive a restart
    new WorktreeService({
      state: w.state,
      hub: w.hub,
      runtime: w.runtime,
      paths: w.paths,
      agents: w.registry,
      namer: async () => null,
    });
    expect(existsSync(join(dirname(dir), "editor-pane"))).toBe(false);
  });

  test("a locked worktree belongs to whoever locked it", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("locked", "held");
    sh(w.repo, "git", "worktree", "lock", "--reason", "claude session dsys (pid 900)", dir);
    w.worktrees.invalidateDiscovered();

    expect(adoptDir(dir)).rejects.toThrow(UserError);
    expect(w.state.worktrees.some((x) => x.branch === "held")).toBe(false);
  });

  test("a worktree nested inside the repo would run its procs in the main checkout", async () => {
    await registered();
    await settle();
    const inside = join(w.repo, "nested");
    sh(w.repo, "git", "worktree", "add", "-q", "-b", "nested-branch", inside, "main");
    w.worktrees.invalidateDiscovered();

    expect(adoptDir(inside)).rejects.toThrow(UserError);
  });

  test("a detached worktree has no branch to land or ship", async () => {
    await registered();
    await settle();
    const dir = join(dirname(w.repo), "loose");
    sh(w.repo, "git", "worktree", "add", "-q", "--detach", dir, "main");
    w.worktrees.invalidateDiscovered();

    expect(adoptDir(dir)).rejects.toThrow(UserError);
  });

  test("a path toyon was never offered is refused", async () => {
    await registered();
    await settle();
    expect(adoptDir(join(dirname(w.repo), "never-existed"))).rejects.toThrow(UserError);
  });
});

describe("a shell at a discovered worktree", () => {
  test("opens at its path, with no runtime and no agent behind it", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("shellhere", "shell-here");
    const [row] = await w.worktrees.discovered();

    w.runtime.openLooseShell(row!.id, row!.path, 80, 24);
    const term = w.terminals.get(row!.id)?.[0];
    // git reports the real directory, so the shell lands there rather than on the /var symlink
    expect(term?.opts.cwd).toBe(realpathSync(dir));
    // nothing else was spun up for it: a discovered worktree runs nothing
    expect(w.agents.get(row!.id)).toBeUndefined();
    expect(w.procs.get(row!.id)).toBeUndefined();
    expect(w.runtime.get(row!.id)).toBeUndefined();
  });

  test("the same directory keeps its shell across re-derivations", async () => {
    await registered();
    await settle();
    foreignWorktree("stable", "stable-branch");
    const first = (await w.worktrees.discovered())[0]!;
    w.runtime.openLooseShell(first.id, first.path, 80, 24);

    w.worktrees.invalidateDiscovered();
    const again = (await w.worktrees.discovered())[0]!;
    expect(again.id).toBe(first.id);
    w.runtime.openLooseShell(again.id, again.path, 80, 24);
    // reused, not respawned: the id is derived from the path, so the stream key held
    expect(w.terminals.get(first.id)?.length).toBe(1);
  });

  test("taking the worktree over takes the loose shell with it", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("adoptshell", "adopt-shell");
    const row = (await w.worktrees.discovered())[0]!;
    w.runtime.openLooseShell(row.id, row.path, 80, 24);
    expect(w.runtime.looseShell(row.id)).toBeDefined();

    await adoptDir(dir);
    await w.worktrees.discovered(); // the derivation that no longer lists it prunes the shell
    expect(w.runtime.looseShell(row.id)).toBeUndefined();
    expect(w.terminals.get(row.id)?.[0]?.alive).toBe(false);
  });
});
