import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh } from "../../test/helpers/tmp-repo.ts";
import {
  adoptDir,
  foreignWorktree,
  foundId,
  registered,
  setRoute,
  settle,
  until,
  useWorld,
  w,
} from "../../test/helpers/world.ts";
import { UserError } from "../core/errors.ts";
import { git } from "../git/exec.ts";
import { WorktreeService } from "./service.ts";

// Worktrees made behind toyon's back: discovering, adopting and shelling into them, and a main measured against its origin.

useWorld();

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
    // the sync wrote under .git/worktrees, so the watcher drops the found rows a debounce later
    // and the next frame derives them again; a status read in between sees no row, as the shell's
    // would, so derive until one answers
    let synced = await w.worktrees.gitStatus(id);
    for (let i = 0; i < 100 && !synced; i++) {
      await Bun.sleep(20);
      await w.worktrees.discovered();
      synced = await w.worktrees.gitStatus(id);
    }
    expect(synced?.behind).toBe(0);
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

describe("main against origin", () => {
  /** a bare "origin" the repo tracks, with main one commit ahead of the checkout */
  async function withUpstream(): Promise<string> {
    const repoId = await registered();
    const bare = join(dirname(w.repo), "origin.git");
    // -b main: the clone pushUpstream makes checks out origin's HEAD, which is init.defaultBranch unless named
    sh(w.repo, "git", "init", "-q", "--bare", "-b", "main", bare);
    sh(w.repo, "git", "remote", "add", "origin", bare);
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "upstream moves on");
    sh(w.repo, "git", "push", "-q", "-u", "origin", "main");
    sh(w.repo, "git", "reset", "-q", "--hard", "HEAD~1");
    return repoId;
  }

  test("main's row counts what it trails on origin; a worktree's row counts against the route's base", async () => {
    const repoId = await withUpstream();
    const wt = await w.worktrees.create(repoId, "feature");
    w.worktrees.invalidateCounts();
    let rows = await w.worktrees.rows();
    const main = rows.find((r) => r.worktree && r.worktree.kind === "main")!;
    expect(main.behind).toBe(1);
    expect(main.ahead).toBeUndefined();
    // the merge route lands on main here, so main here is what the row is measured against
    expect(rows.find((r) => r.id === wt.id)?.behind).toBe(0);
    // the push route lands on origin's main: the same row trails it by the commit main here lacks
    await setRoute(repoId, "push");
    expect(w.state.requireRepo(repoId).base).toBe("origin/main");
    rows = await w.worktrees.rows();
    expect(rows.find((r) => r.id === wt.id)?.behind).toBe(1);
    expect(rows.find((r) => r.id === main.id)?.behind).toBe(1);
  });

  test("a main with no upstream has no count", async () => {
    await registered();
    const main = (await w.worktrees.rows()).find((r) => r.worktree && r.worktree.kind === "main")!;
    expect(main.behind).toBeUndefined();
  });

  test("pull fast-forwards main and every worktree's count moves with it", async () => {
    const repoId = await withUpstream();
    const wt = await w.worktrees.create(repoId, "feature");
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    // after the setup, or its own frame lands in the count and the pull is blamed for it
    await settle();
    // the frame with the op gone is the one carrying the moved counts; the pull's own frames
    // (its start, its step) precede it
    let frames = 0;
    w.hub.on("worktreesChanged", () => {
      if (!w.worktrees.shippingOf(main.id)) frames++;
    });
    const result = await w.worktrees.pull(main.id);
    expect(result).toMatchObject({ ok: true, message: "pulled 1 commit(s) from origin" });
    expect(frames).toBe(1);
    const rows = await w.worktrees.rows();
    expect(rows.find((r) => r.id === main.id)?.behind).toBe(0);
    expect(rows.find((r) => r.id === wt.id)?.behind).toBe(1);
    expect((await w.worktrees.pull(main.id)).message).toBe("already up to date with origin");
  });

  /** a commit on origin that main here does not have, made from a clone so main itself stays put */
  function pushUpstream(message: string): string {
    const bare = join(dirname(w.repo), "origin.git");
    const clone = join(dirname(w.repo), "clone");
    if (!existsSync(clone)) sh(dirname(w.repo), "git", "clone", "-q", bare, clone);
    sh(clone, "git", "pull", "-q", "--rebase");
    sh(clone, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", message);
    sh(clone, "git", "push", "-q", "origin", "main");
    return sh(clone, "git", "rev-parse", "HEAD").trim();
  }

  /** origin's main takes a commit that writes `name`: what a fast-forward here has to rewrite */
  function pushUpstreamFile(name: string, text: string): string {
    const bare = join(dirname(w.repo), "origin.git");
    const clone = join(dirname(w.repo), "clone");
    if (!existsSync(clone)) sh(dirname(w.repo), "git", "clone", "-q", bare, clone);
    sh(clone, "git", "pull", "-q", "--rebase");
    writeFileSync(join(clone, name), text);
    sh(clone, "git", "add", "-A");
    sh(clone, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `write ${name}`);
    sh(clone, "git", "push", "-q", "origin", "main");
    return sh(clone, "git", "rev-parse", "HEAD").trim();
  }
  /** a service with no fetch on record, the way a minute's wait leaves the trunk */
  const fresh = () =>
    new WorktreeService({
      state: w.state,
      hub: w.hub,
      runtime: w.runtime,
      paths: w.paths,
      agents: w.registry,
      namer: async () => null,
    });
  const headOf = (path: string) => sh(path, "git", "rev-parse", "HEAD").trim();

  test("a route change in the settings file moves the base, and every count with it", async () => {
    const repoId = await withUpstream();
    const wt = await w.worktrees.create(repoId, "feature");
    expect((await w.worktrees.gitStatus(wt.id))?.behind).toBe(0);
    let ticks = 0;
    w.hub.on("repoTick", () => ticks++);
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" }, land: { route: "pr" } }));
    w.repos.reloadConfig(repoId);
    await until(() => w.state.requireRepo(repoId).base === "origin/main");
    expect(ticks).toBeGreaterThan(0);
    expect((await w.worktrees.gitStatus(wt.id))?.behind).toBe(1);
    // and back: main here is the base again, which the row is level with
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" } }));
    w.repos.reloadConfig(repoId);
    await until(() => w.state.requireRepo(repoId).base === undefined);
    expect((await w.worktrees.gitStatus(wt.id))?.behind).toBe(0);
  });

  test("on the push route a main checkout that is dirty and on another branch blocks no count, sync or birth", async () => {
    const repoId = await withUpstream();
    await setRoute(repoId, "push");
    // main here is nobody's business from here on: checked out elsewhere, with an edit in it
    sh(w.repo, "git", "switch", "-q", "-c", "elsewhere");
    writeFileSync(join(w.repo, "README.md"), "edited on main\n");
    const wt = await w.worktrees.create(repoId, "feature");
    // born from origin's main, not the checkout here, and tracking nothing
    expect(headOf(wt.path)).toBe(sh(w.repo, "git", "rev-parse", "origin/main").trim());
    expect((await git(wt.path, "rev-parse", "--abbrev-ref", `${wt.branch}@{upstream}`)).ok).toBe(false);
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ files: [], ahead: 0, behind: 0 });
    // origin moves on: the sync's own fetch finds it, and the row takes it in
    const c = pushUpstream("c");
    const { result } = await w.worktrees.sync(wt.id);
    expect(result.ok).toBe(true);
    expect(headOf(wt.path)).toBe(c);
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ ahead: 0, behind: 0 });
    // main here stayed where it was, on its other branch, edit and all
    expect(sh(w.repo, "git", "branch", "--show-current").trim()).toBe("elsewhere");
    expect(readFileSync(join(w.repo, "README.md"), "utf8")).toBe("edited on main\n");
  });

  test("a fetch that fails is on the trunk, beside when origin last answered", async () => {
    const repoId = await withUpstream();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    expect((await w.worktrees.pull(main.id)).ok).toBe(true);
    const answered = (await w.worktrees.trunks())[repoId]!;
    expect(answered.fetchedAt).toBeGreaterThan(0);
    expect(answered.fetchFailed).toBeUndefined();
    rmSync(join(dirname(w.repo), "origin.git"), { recursive: true, force: true });
    expect((await w.worktrees.pull(main.id)).ok).toBe(false);
    const failed = (await w.worktrees.trunks())[repoId]!;
    expect(failed.fetchedAt).toBe(answered.fetchedAt);
    expect(failed.fetchFailed).toMatch(/does not appear to be a git repos/);
  });

  test("syncTrunk fast-forwards a clean main behind origin, and fetches once a minute at most", async () => {
    const repoId = await withUpstream();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    const upstream = sh(w.repo, "git", "rev-parse", "origin/main").trim();
    await w.worktrees.syncTrunk(repoId);
    expect(headOf(w.repo)).toBe(upstream);
    expect((await w.worktrees.trunks())[repoId]).toMatchObject({ id: main.id, behind: 0 });
    expect((await w.worktrees.trunks())[repoId]?.stale).toBeUndefined();
    // origin moves again within the minute: the plus opened now does not fetch, so nothing knows
    const b = pushUpstream("b");
    await w.worktrees.syncTrunk(repoId);
    expect(sh(w.repo, "git", "rev-parse", "origin/main").trim()).toBe(upstream);
    expect(headOf(w.repo)).not.toBe(b);
    // a minute later it does, and main follows
    await fresh().syncTrunk(repoId);
    expect(headOf(w.repo)).toBe(b);
  });

  test("a main with a file in the pull's way, or diverged, is left where it is, and the trunk says which", async () => {
    const repoId = await withUpstream();
    const before = headOf(w.repo);
    // origin's commit writes wip.txt, and an uncommitted wip.txt sits here: the one file the
    // fast-forward would overwrite, so it stands and says so
    const theirs = pushUpstreamFile("wip.txt", "theirs\n");
    writeFileSync(join(w.repo, "wip.txt"), "x\n");
    const dirty = fresh();
    await dirty.syncTrunk(repoId);
    expect(headOf(w.repo)).toBe(before);
    expect((await dirty.trunks())[repoId]).toMatchObject({ behind: 2, dirty: 1, stale: "dirty" });
    // the same edit under a name the pull does not touch is no reason to stand: main follows
    // and the file rides along, still uncommitted
    rmSync(join(w.repo, "wip.txt"));
    writeFileSync(join(w.repo, "aside.txt"), "x\n");
    const aside = fresh();
    await aside.syncTrunk(repoId);
    expect(headOf(w.repo)).toBe(theirs);
    expect((await aside.trunks())[repoId]).toMatchObject({ behind: 0, dirty: 1 });
    expect((await aside.trunks())[repoId]?.stale).toBeUndefined();
    expect(sh(w.repo, "git", "status", "--porcelain")).toBe("?? aside.txt");
    // committed here instead: main has its own commit and origin has one too
    rmSync(join(w.repo, "aside.txt"));
    pushUpstream("theirs again");
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "mine");
    const diverged = fresh();
    await diverged.syncTrunk(repoId);
    expect((await diverged.trunks())[repoId]).toMatchObject({ behind: 1, stale: "diverged" });
    expect(sh(w.repo, "git", "log", "-1", "--format=%s").trim()).toBe("mine");
  });

  test("a main with no upstream says so and is not fetched", async () => {
    const repoId = await registered();
    const svc = fresh();
    await svc.syncTrunk(repoId);
    const trunk = (await svc.trunks())[repoId]!;
    expect(trunk.behind).toBeUndefined();
    expect(trunk.stale).toBe("no-upstream");
  });

  test("the rows' own fetch finding main behind takes origin in the same way", async () => {
    await withUpstream();
    const upstream = sh(w.repo, "git", "rev-parse", "origin/main").trim();
    const c = pushUpstream("c");
    // a service that has never fetched: the rows count main, fetch, and follow
    const svc = fresh();
    await svc.rows();
    await until(() => headOf(w.repo) === c);
    expect(headOf(w.repo)).not.toBe(upstream);
  });

  test("pull refuses a main with a file in its way, naming it, and a worktree", async () => {
    const repoId = await withUpstream();
    const wt = await w.worktrees.create(repoId, "feature");
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    // an uncommitted file the pull does not touch is no reason to refuse
    writeFileSync(join(w.repo, "aside.txt"), "x\n");
    expect((await w.worktrees.pull(main.id)).ok).toBe(true);
    // one it would overwrite is
    pushUpstreamFile("wip.txt", "theirs\n");
    writeFileSync(join(w.repo, "wip.txt"), "x\n");
    const r = await w.worktrees.pull(main.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("would overwrite (wip.txt)");
    await expect(w.worktrees.pull(wt.id)).rejects.toBeInstanceOf(UserError);
  });
});
