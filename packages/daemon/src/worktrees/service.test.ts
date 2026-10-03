import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sh } from "../../test/helpers/tmp-repo.ts";
import { adoptDir, foreignWorktree, noSelf, registered, settle, until, useWorld, w } from "../../test/helpers/world.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import { FileService } from "../files/service.ts";
import { GIT, git } from "../git/exec.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { WorktreeService } from "./service.ts";

// Real git in a throwaway repo, the world in test/helpers/world.ts. A project's rows from registering on: creating, removing, its settings and profiles, and what a turn's end redetects.

useWorld();

describe("register", () => {
  test("records the main pseudo-worktree and starts nothing; a look at it starts it while no spare stands in", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(main.repoId).toBe(repoId);
    expect(w.runtime.get(main.id) ?? null).toBeNull();
    w.repos.touch(main.id);
    await until(() => !!w.runtime.get(main.id)?.procs);
    expect(w.agents.get(main.id)).toBeDefined();
    expect(w.procs.get(main.id)?.started.length).toBe(1);
  });

  test("main runs only as the lead: the spare coming up stops its procs, and a start on it is refused", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.repos.touch(main.id);
    await until(() => !!w.runtime.get(main.id)?.procs);
    await w.worktrees.spare.ensure(repoId);
    await until(() => !w.runtime.get(main.id)?.procs);
    expect(w.procs.get(main.id)?.stopped).toBe(true);
    // while the spare stands in, nothing brings main's procs back
    w.repos.touch(main.id);
    await settle();
    expect(w.runtime.get(main.id)?.procs ?? null).toBeNull();
    // the spare claimed and the next one warming: main stays cold through it
    await w.worktrees.create(repoId, "task");
    await settle();
    expect(w.runtime.get(main.id)?.procs ?? null).toBeNull();
  });
});

describe("create / remove", () => {
  test("create adds a git worktree on an toyon/ branch and the agent receives the prompt", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "make the header sticky");
    expect(wt.kind).toBe("worktree");
    // born on its directory's id, which is the record id's head; the words are the title's, and
    // the branch takes them once named
    expect(basename(wt.path)).toBe(`wt-${wt.id.slice(0, 4)}`);
    expect(wt.branch).toBe(`toyon/${basename(wt.path)}`);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(wt.title).toBe("Make the header");
    expect(wt.unnamed).toBe(true);
    expect(w.agents.get(wt.id)?.sent[0]?.text).toBe("make the header sticky");
    expect(wt.promptedAt).toBeGreaterThan(0);
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

  // A worktree gets the branch's files, so a .gitignore nobody has committed is not among them,
  // and every ignored file in the tree (the deps copy first of all) reads as untracked work. The
  // rules are mirrored, not the file: a carried .gitignore would be untracked work of its own, and
  // a worktree with any is one land and sync both refuse.
  test("an uncommitted .gitignore is mirrored, so the deps copy is not untracked work", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".gitignore"), "node_modules/\n");
    mkdirSync(join(w.repo, "node_modules"), { recursive: true });
    writeFileSync(join(w.repo, "node_modules", "dep.js"), "x\n");
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(existsSync(join(wt.path, ".gitignore"))).toBe(false);
    expect(existsSync(join(wt.path, "node_modules", "dep.js"))).toBe(true);
    expect((await w.worktrees.gitStatus(wt.id))?.files).toEqual([]);
  });

  // what one worktree built to pass the check reaches the next before its setup runs, ahead of
  // main's own copy, so an install with nothing to do meets the tree already made
  test("a kept cache is restored into a new worktree before its setup commands run", async () => {
    const repoId = await registered();
    const repo = w.state.requireRepo(repoId);
    repo.config = {
      run: { web: "true" },
      check: "true",
      setup: ["test -e .mypy_cache/x && touch restored"],
      cache: [".mypy_cache"],
    };
    writeFileSync(join(w.repo, ".gitignore"), ".mypy_cache/\nrestored\n");
    sh(w.repo, GIT, "add", ".gitignore");
    sh(w.repo, GIT, "commit", "-qm", "ignore the cache");
    const first = await w.worktrees.create(repoId, "first");
    await settle();
    mkdirSync(join(first.path, ".mypy_cache"), { recursive: true });
    writeFileSync(join(first.path, ".mypy_cache", "x"), "checked\n");
    const lines: string[] = [];
    w.hub.on("log", (_id, proc, line) => {
      if (proc === "setup") lines.push(line);
    });
    // the stages the setup run passes through on the row, so the wait can say what it is on
    const stages: string[] = [];
    w.hub.on("worktreesChanged", () => {
      for (const wt of w.state.worktrees) {
        const stage = wt.runs?.find((r) => r.kind === "setup")?.stage;
        if (stage && stages.at(-1) !== stage) stages.push(stage);
      }
    });
    w.hub.emit("checkPassed", first.id);
    // an entry is built beside its family and renamed in whole, so the family folder exists while
    // there is still nothing to restore; the manifest is what says the entry is kept
    const kept = () => {
      const repoDir = join(w.paths.cacheDir, repoId);
      if (!existsSync(repoDir)) return false;
      return readdirSync(repoDir).some((family) =>
        readdirSync(join(repoDir, family)).some((entry) => existsSync(join(repoDir, family, entry, "manifest.json"))),
      );
    };
    await until(kept);
    const second = await w.worktrees.create(repoId, "second");
    await until(() => existsSync(join(second.path, "restored")));
    // the file is there before the command's shell has exited, and the run goes only once it has
    await until(() => !w.state.worktree(second.id)?.runs);
    expect(readFileSync(join(second.path, ".mypy_cache", "x"), "utf8")).toBe("checked\n");
    expect(lines.find((l) => l.startsWith("cache:"))).toMatch(/^cache: restored \.mypy_cache from [0-9a-f]{7}/);
    expect(stages).toEqual(["restoring cache", "test -e .mypy_cache/x && touch restored"]);
    expect(w.state.worktree(second.id)?.runs).toBeUndefined();
    expect((await w.worktrees.gitStatus(second.id))?.files).toEqual([]);
  });

  test("a second setup rewrites the mirrored block rather than stacking another", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".gitignore"), "node_modules/\n");
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    writeFileSync(join(w.repo, ".gitignore"), "node_modules/\ndist/\n");
    await w.worktrees.setupAndStart(wt, w.state.repo(wt.repoId)!, w.repo);
    const text = readFileSync(join(w.repo, ".git/info/exclude"), "utf8");
    expect(text.match(/# toyon base \.gitignore$/gm)?.length).toBe(1);
    expect(text).toContain("dist/");
  });

  // info/exclude is one file for the whole repo, so the block is keyed on the base checkout: a
  // setup for a worktree that carries its own .gitignore leaves the block an earlier one reads
  test("a worktree with a .gitignore of its own does not clear the block for the others", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".gitignore"), "node_modules/\n");
    mkdirSync(join(w.repo, "node_modules"), { recursive: true });
    writeFileSync(join(w.repo, "node_modules", "dep.js"), "x\n");
    const first = await w.worktrees.create(repoId, "first");
    await settle();
    const second = await w.worktrees.create(repoId, "second");
    await settle();
    writeFileSync(join(second.path, ".gitignore"), "dist/\n");
    sh(second.path, GIT, "add", ".gitignore");
    sh(second.path, GIT, "commit", "-qm", "ignore dist");
    await w.worktrees.setupAndStart(second, w.state.repo(repoId)!, w.repo);
    expect(readFileSync(join(w.repo, ".git/info/exclude"), "utf8")).toContain("node_modules/");
    expect((await w.worktrees.gitStatus(first.id))?.files).toEqual([]);
    // once the base tracks its .gitignore every branch cut from it carries the rules, and the
    // block goes with the next setup
    sh(w.repo, GIT, "add", ".gitignore");
    sh(w.repo, GIT, "commit", "-qm", "ignore deps");
    await w.worktrees.setupAndStart(first, w.state.repo(repoId)!, w.repo);
    expect(readFileSync(join(w.repo, ".git/info/exclude"), "utf8")).not.toContain("node_modules/");
  });

  test("a committed .gitignore is the branch's own, and nothing is mirrored over it", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".gitignore"), "dist/\n");
    sh(w.repo, GIT, "add", ".gitignore");
    sh(w.repo, GIT, "commit", "-qm", "ignore dist");
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(readFileSync(join(w.repo, ".git/info/exclude"), "utf8")).not.toContain("dist/");
    expect(readFileSync(join(wt.path, ".gitignore"), "utf8")).toBe("dist/\n");
  });

  test("a main that git reads as bare refuses the create and makes no worktree", async () => {
    const repoId = await registered();
    sh(w.repo, "git", "config", "core.bare", "true");
    await expect(w.worktrees.create(repoId, "make the header sticky")).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktrees.filter((x) => x.kind === "worktree")).toEqual([]);
  });

  test("create stamps the requested agent, else the daemon default; unknown ids are UserErrors", async () => {
    const repoId = await registered();
    expect((await w.worktrees.create(repoId, "a", { agent: "codex" })).agent).toBe("codex");
    w.state.setDefaultAgent("codex");
    expect((await w.worktrees.create(repoId, "b")).agent).toBe("codex");
    await expect(w.worktrees.create(repoId, "c", { agent: "nope" })).rejects.toBeInstanceOf(UserError);
  });

  test("remove stops the agent and procs, deletes the directory, branch and state row, and archives the transcript", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    // unmerged work on the branch: the confirm said it would be lost, so the delete is forced
    writeFileSync(join(wt.path, "new.txt"), "x\n");
    sh(wt.path, "git", "add", "new.txt");
    sh(wt.path, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unmerged");
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, wt.id), "{}\n");
    await w.worktrees.archiveWorktree(wt.id);
    expect(w.agents.get(wt.id)?.closes).toBe(1);
    expect(w.procs.get(wt.id)?.stopped).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(w.repo, "git", "branch", "--list", wt.branch)).toBe("");
    expect(existsSync(transcriptPathFor(w.paths.transcriptsDir, wt.id))).toBe(false);
    expect(existsSync(join(w.paths.archiveDir, wt.id, "transcript.jsonl"))).toBe(true);
    expect(w.state.worktree(wt.id)).toBeUndefined();
    expect(w.runtime.get(wt.id)).toBeUndefined();
  });

  test("remove runs the repo's teardown in the directory first, and a failing step does not keep it", async () => {
    const repoId = await registered();
    const repo = w.state.requireRepo(repoId);
    // the first step records where it ran and as whom; the second fails, and the removal goes on
    repo.config = {
      ...repo.config,
      teardown: [`printf '%s' "$TOYON_WORKTREE" > "$TOYON_ROOT/TORN_DOWN"`, "exit 3"],
    };
    w.state.save();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    await w.worktrees.archiveWorktree(wt.id);
    expect(readFileSync(join(w.repo, "TORN_DOWN"), "utf8")).toBe(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(w.state.worktree(wt.id)).toBeUndefined();
  });

  test("removing an adopted worktree keeps the person's branch", async () => {
    await registered();
    await settle();
    const wt = await adoptDir(foreignWorktree("theirs", "their-branch"));
    await settle();
    await w.worktrees.archiveWorktree(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(w.repo, "git", "branch", "--list", "their-branch")).toBe("their-branch");
  });

  test("main cannot be removed", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    await w.worktrees.archiveWorktree(main.id);
    expect(w.state.worktree(main.id)).toBeDefined();
  });

  // The remove empties the directory file by file and git answers honestly about a half-empty
  // tree, so mid-remove every file still in it reads as deleted: 15k of them on a 20k-file
  // worktree, which the panel drew as the whole repo being wiped. Nothing is read on the way out.
  test("a worktree on its way out is not read: no status frame, and no count for the rail", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(await w.worktrees.gitStatus(wt.id)).not.toBeNull();
    const going = w.worktrees.archiveWorktree(wt.id);
    expect(await w.worktrees.gitStatus(wt.id)).toBeNull();
    expect(await w.worktrees.freshCounts(wt.id)).toEqual({});
    await going;
  });

  test("the status says what the last turn changed, once that is less than everything uncommitted", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    await w.worktrees.turnStarted(wt.id);
    writeFileSync(join(wt.path, "a.txt"), "one\n");
    // one turn in: the uncommitted list is the turn
    expect((await w.worktrees.gitStatus(wt.id))?.turn).toBeUndefined();
    await w.worktrees.turnStarted(wt.id);
    writeFileSync(join(wt.path, "b.txt"), "two\n");
    const info = await w.worktrees.gitStatus(wt.id);
    expect(info?.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(info?.turn?.files).toEqual([{ xy: "A ", path: "b.txt", add: 1, del: 0 }]);
    // the read a last turn row asks for: the working file beside the tree the turn started from
    writeFileSync(join(wt.path, "a.txt"), "one\nmore\n");
    const base = (await w.worktrees.gitStatus(wt.id))!.turn!.base;
    const files = new FileService(w.state, w.runtime, (id) => w.worktrees.readable(id));
    expect(await files.read(wt.id, "a.txt", undefined, base)).toMatchObject({
      before: "one\n",
      after: "one\nmore\n",
      writable: true,
    });
    // the worktree going takes the kept trees with it
    await w.worktrees.discardWorktree(wt.id);
    expect(sh(w.repo, GIT, "for-each-ref", "refs/toyon/turns/")).toBe("");
  });

  test("a discard is on its way out too, and no archive covers it", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(await w.worktrees.gitStatus(wt.id)).not.toBeNull();
    const going = w.worktrees.discardWorktree(wt.id);
    expect(await w.worktrees.gitStatus(wt.id)).toBeNull();
    await going;
  });
});

describe("confirmConfig", () => {
  test("restarts procs but keeps the same agent object", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    const agent = w.runtime.get(wt.id)!.agent;
    const procsBefore = w.procs.get(wt.id)!;
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" } }, "local");
    await settle();
    expect(w.runtime.get(wt.id)!.agent).toBe(agent);
    // an opened repo gets one person's file, which git does not list
    expect(w.state.requireRepo(repoId).configFile).toBe(".toyon/settings.local.json");
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({
      run: { web: "true", api: "true" },
    });
    expect((await git(w.repo, "status", "--porcelain")).out).toBe("");
    expect(procsBefore.stopped).toBe(true);
    expect(
      w.procs
        .get(wt.id)!
        .started.map((p) => p.name)
        .sort(),
    ).toEqual(["api", "web"]);
  });

  const excludes = () => readFileSync(join(w.repo, ".git/info/exclude"), "utf8");
  const untracked = async () => (await git(w.repo, "status", "--porcelain", "--untracked-files=all")).out;

  test("committed moves a local file into the shared one and lets git see it again", async () => {
    const repoId = await registered();
    await w.repos.confirmConfig(repoId, { run: { web: "true" } }, "local");
    expect(excludes()).toContain(".toyon/settings.local.json");
    await w.repos.confirmConfig(repoId, { run: { web: "true" }, setup: ["make"] }, "shared");
    expect(existsSync(join(w.repo, ".toyon/settings.local.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.json"), "utf8"))).toEqual({
      run: { web: "true" },
      setup: ["make"],
    });
    expect(w.state.requireRepo(repoId).configFile).toBe(".toyon/settings.json");
    // the exclude line goes with the file, so a local file written later by hand is excluded afresh
    expect(excludes()).not.toContain("settings.local.json");
    expect(await untracked()).toBe("?? .toyon/settings.json");
  });

  test("kept local moves a shared file nobody committed, and leaves one the team has", async () => {
    const repoId = await registered();
    mkdirSync(join(w.repo, ".toyon"));
    writeFileSync(join(w.repo, ".toyon/settings.json"), JSON.stringify({ run: { web: "true" } }));
    w.repos.reloadConfig(repoId);
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" } }, "local");
    expect(existsSync(join(w.repo, ".toyon/settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({
      run: { web: "true", api: "true" },
    });
    expect(await untracked()).toBe("");

    // the same choice over a committed file is an override: the team's file is not ours to take
    writeFileSync(join(w.repo, ".toyon/settings.json"), JSON.stringify({ run: { web: "true" } }));
    sh(w.repo, GIT, "add", ".toyon/settings.json");
    sh(w.repo, GIT, "commit", "-q", "-m", "settings");
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" } }, "local");
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.json"), "utf8"))).toEqual({ run: { web: "true" } });
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({
      run: { api: "true" },
    });
    expect(await untracked()).toBe("");
  });

  test("the choice keeps the place the settings already are in", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, "toyon.local.json"), JSON.stringify({ run: { web: "true" } }));
    w.repos.reloadConfig(repoId);
    await w.repos.confirmConfig(repoId, { run: { web: "true" } }, "shared");
    expect(existsSync(join(w.repo, "toyon.local.json"))).toBe(false);
    expect(existsSync(join(w.repo, "toyon.json"))).toBe(true);
    expect(w.state.requireRepo(repoId).configFile).toBe("toyon.json");
  });
});

describe("profiles", () => {
  const profiled = {
    run: { api: "true", web: "true" },
    profiles: { full: { run: ["api", "web"] }, fe: { run: ["web"] } },
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
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true", api: "true" } }));
    w.repos.reloadConfig(repoId);
    await settle();
    expect(w.state.requireRepo(repoId).config.run).toEqual({ web: "true", api: "true" });
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
    expect(w.state.requireRepo(repoId).config.run).toEqual({ web: "true", api: "true" });
    expect(w.procs.get(wt.id)).toBe(procsNow);
    expect(lines[0]).toMatch(/not valid JSON/);
    expect(repos).toBe(1);
  });

  test("a key toyon does not know is named in main's log, even when nothing else changed", async () => {
    const repoId = await registered();
    const lines: string[] = [];
    w.hub.on("log", (_id, proc, line) => proc === "config" && lines.push(line));
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" }, chek: "bun test" }));
    w.repos.reloadConfig(repoId);
    expect(w.state.requireRepo(repoId).config).toEqual({ run: { web: "true" } });
    expect(lines).toEqual(["ignoring toyon.json: chek, which Toyon does not know"]);
  });

  test("a file in .toyon/ is read like one at the root, and moving it there changes where a save goes", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" } }));
    w.repos.reloadConfig(repoId);
    expect(w.state.requireRepo(repoId).configFile).toBe("toyon.json");
    rmSync(join(w.repo, "toyon.json"));
    mkdirSync(join(w.repo, ".toyon"));
    writeFileSync(join(w.repo, ".toyon/settings.json"), JSON.stringify({ run: { web: "true", api: "true" } }));
    writeFileSync(join(w.repo, ".toyon/settings.local.json"), JSON.stringify({ run: { api: null } }));
    w.repos.reloadConfig(repoId);
    expect(w.state.requireRepo(repoId).config.run).toEqual({ web: "true" });
    expect(w.state.requireRepo(repoId).configFile).toBe(".toyon/settings.local.json");
    // a save over the shared file keeps only the difference, so the team's later edits still arrive
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" }, setup: ["make"] }, "local");
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({ setup: ["make"] });
    // one person's file is out of git, the shared one is not
    expect((await git(w.repo, "status", "--porcelain", "--untracked-files=all")).out).toBe("?? .toyon/settings.json");
  });

  test("boot picks up a toyon.json written while the daemon was down", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { api: "true" } }));
    // a second registry over the same state, as a restart would build
    const again = new RepoRegistry({
      state: w.state,
      hub: w.hub,
      runtime: w.runtime,
      worktrees: w.worktrees,
      ...noSelf(w.state, w.hub),
    });
    await again.boot();
    again.stopWatchers();
    expect(w.state.requireRepo(repoId).config.run).toEqual({ api: "true" });
    expect(w.state.requireRepo(repoId).needsSetup).toBe(false);
  });
});

describe("empty tree", () => {
  test("main's record says whether the tree is empty; a task worktree never does", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    expect(main.empty).toBe(false);
    const wt = await w.worktrees.create(repoId, "task");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.requireWorktree(wt.id).empty).toBeUndefined();
  });

  test("a project made from the picker is empty until something lands in it, and the rows say so", async () => {
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
    expect(main.empty).toBe(true);
    expect((await w.worktrees.rows({ quick: true })).find((r) => r.id === main.id)?.worktree?.empty).toBe(true);
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>\n");
    await w.worktrees.gitStatus(main.id);
    expect(w.state.requireWorktree(main.id).empty).toBe(false);
    // the same answer again is not a change (counted after the register's spare has settled,
    // since its own worktreesChanged lands whenever it likes)
    await settle();
    let changed = 0;
    w.hub.on("worktreesChanged", () => changed++);
    await w.worktrees.gitStatus(main.id);
    expect(changed).toBe(0);
  });
});

describe("quick rows", () => {
  test("answers from the caches without git, then queues the real pass", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    let changed = 0;
    w.hub.on("worktreesChanged", () => changed++);
    // nothing cached yet: the row comes back without counts and a pass is queued behind it
    const cold = await w.worktrees.rows({ quick: true });
    expect(cold.find((r) => r.id === main.id)?.dirty).toBeUndefined();
    await settle();
    expect(changed).toBe(1);
    // the full pass fills the cache; quick now answers with it and queues nothing
    const full = await w.worktrees.rows();
    expect(full.find((r) => r.id === main.id)?.dirty).toBe(0);
    const warm = await w.worktrees.rows({ quick: true });
    expect(warm.find((r) => r.id === main.id)?.dirty).toBe(0);
    await settle();
    expect(changed).toBe(1);
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
      run: { web: "bun run dev --port $PORT --strictPort" },
      setup: ["bun install"],
    });
    expect(w.state.requireRepo(repo.id).needsSetup).toBe(true);
    expect(repos).toBe(1);
    // the same tree again says nothing new
    turnEnd(main.id);
    expect(repos).toBe(1);
  });

  test("a build file with no page is assumed until a scaffold or a saved setup says otherwise", async () => {
    writeFileSync(join(w.repo, "Cargo.toml"), '[package]\nname = "tool"\n');
    const repo = await w.repos.register(w.repo);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    expect(repo).toMatchObject({ needsSetup: true, assumed: "Cargo.toml", config: { run: {} } });
    // the agent scaffolds a front end beside it: its start command is the guess, and setup is asked again
    writeFileSync(join(w.repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).assumed).toBeUndefined();
    expect(w.state.requireRepo(repo.id).guess).toBe("package.json");
    rmSync(join(w.repo, "package.json"));
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).assumed).toBe("Cargo.toml");
    // saving setup confirms it and ends the assumption
    await w.repos.confirmConfig(repo.id, { run: {} }, "local");
    expect(w.state.requireRepo(repo.id)).toMatchObject({ needsSetup: false, config: { run: {} } });
    expect(w.state.requireRepo(repo.id).assumed).toBeUndefined();
  });

  test("a toyon.json the agent wrote applies at once, like a hand-written one", async () => {
    const repo = await w.repos.register(w.repo);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).needsSetup).toBe(false);
    expect(w.state.requireRepo(repo.id).config.run).toEqual({ web: "true" });
  });

  test("a confirmed repo keeps its config whatever lands in the tree", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    writeFileSync(join(w.repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repoId).config).toEqual({ run: { web: "true" } });
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
    // nothing was sent, so it sorts by when it was made
    expect(wt.promptedAt).toBeUndefined();
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
    await expect(w.worktrees.land(pr.id)).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.openRef(repoId, "pr", "x")).rejects.toBeInstanceOf(UserError);
  });
});

describe("usage on the row", () => {
  test("the stream's last figures ride on the row, and a cold worktree's come from its transcript", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    expect((await w.worktrees.rows()).find((r) => r.id === wt.id)?.usage).toBeUndefined();
    w.hub.emit("agent", wt.id, 1, { type: "usage", used: 1000, size: 4000, cost: 0.2, ts: 0 });
    expect((await w.worktrees.rows()).find((r) => r.id === wt.id)?.usage).toEqual({
      used: 1000,
      size: 4000,
      cost: 0.2,
    });

    // a second service over the same state and files: the figures come from the transcript
    const cold = await w.worktrees.create(repoId, "cold");
    writeFileSync(
      transcriptPathFor(w.paths.transcriptsDir, cold.id),
      [
        JSON.stringify({ seq: 0, event: { type: "usage", used: 500, size: 4000, cost: 0.05, ts: 0 } }),
        JSON.stringify({ seq: 1, event: { type: "text-delta", text: "later" } }),
        JSON.stringify({ seq: 2, event: { type: "usage", used: 900, size: 4000, ts: 0 } }),
        "",
      ].join("\n"),
    );
    const again = new WorktreeService({
      state: w.state,
      hub: w.hub,
      runtime: w.runtime,
      paths: w.paths,
      agents: w.registry,
      namer: async () => null,
    });
    expect((await again.rows()).find((r) => r.id === cold.id)?.usage).toEqual({ used: 900, size: 4000 });
  });
});
