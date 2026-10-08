import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "../../test/helpers/tmp-repo.ts";
import { registered, setRoute, useWorld, w } from "../../test/helpers/world.ts";
import { git } from "../git/exec.ts";

// Landing on the push and pr routes, where origin's main is the one that counts and other hands move it.

useWorld();

describe("landing", () => {
  /** a bare origin main tracks, on the push route, and a second clone as the hands other people are */
  const pushRoute = async (repoId: string) => {
    const origin = join(w.repo, "..", "origin.git");
    // -b main: a clone of origin checks out its HEAD, which is init.defaultBranch unless named
    sh(w.repo, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(w.repo, "git", "remote", "add", "origin", origin);
    sh(w.repo, "git", "push", "-q", "-u", "origin", "main");
    await setRoute(repoId, "push");
    const other = join(w.repo, "..", "other");
    sh(w.repo, "git", "clone", "-q", origin, other);
    sh(other, "git", "config", "user.email", "o@o");
    sh(other, "git", "config", "user.name", "o");
    return { origin, other };
  };
  /** a pre-push hook that pushes a commit from the other clone under the push: once, or every time */
  const raceHook = (other: string, once: boolean) => {
    const flag = join(w.repo, "..", "raced");
    // beside the checkout and named as the hooks path, since a global hooks path would hide one
    // written into .git/hooks
    const hooks = join(w.repo, "..", "racehooks");
    mkdirSync(hooks, { recursive: true });
    sh(w.repo, "git", "config", "core.hooksPath", hooks);
    writeFileSync(
      join(hooks, "pre-push"),
      [
        "#!/bin/sh",
        "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
        once ? `if [ -e "${flag}" ]; then exit 0; fi` : "",
        `touch "${flag}"`,
        `cd "${other}" && git fetch -q origin main && git reset -q --hard FETCH_HEAD`,
        "git commit -q --allow-empty -m elsewhere && git push -q origin main",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return () => {
      rmSync(join(hooks, "pre-push"), { force: true });
      rmSync(flag, { force: true });
      sh(w.repo, "git", "config", "--unset", "core.hooksPath");
    };
  };

  test("the push route lands from the worktree onto origin's main, and meets origin moving under it once", async () => {
    const repoId = await registered();
    const { origin, other } = await pushRoute(repoId);
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const { result } = await w.worktrees.land(wt.id, "add feature");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("committed and merged into main and pushed; main here pulled it");
    expect((await git(origin, "log", "-1", "--format=%s", "main^2")).out).toBe("add feature");
    expect((await git(w.repo, "rev-parse", "main")).out).toBe((await git(origin, "rev-parse", "main")).out);
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(origin, "rev-parse", "main")).out);
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true });
    // origin moves under the next press, after the push has read origin: refused once, then the
    // land fetches, rebases, rebuilds and pushes again, and both landings are on origin's main
    const undo = raceHook(other, true);
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    const again = await w.worktrees.land(wt.id, "add more");
    expect(again.result.ok).toBe(true);
    const subjects = (await git(origin, "log", "--first-parent", "--format=%s", "-n", "4")).out.split("\n");
    expect(subjects[1]).toBe("elsewhere");
    expect((await git(origin, "log", "-1", "--format=%s", "main^2")).out).toBe("add more");
    undo();
    // origin that moves under every push is not raced for ever: the second rejection stops, with
    // the branch clean, committed and ready for the next press
    const always = raceHook(other, false);
    writeFileSync(join(wt.path, "third.txt"), "z\n");
    const twice = await w.worktrees.land(wt.id, "add a third");
    expect(twice.result.ok).toBe(false);
    expect(twice.result.message).toContain("land again");
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    expect((await git(wt.path, "branch", "--show-current")).out).toBe(wt.branch);
    always();
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
    expect((await git(origin, "log", "-1", "--format=%s", "main^2")).out).toBe("add a third");
  });

  test("the push route needs nothing of the main checkout", async () => {
    const repoId = await registered();
    const { origin } = await pushRoute(repoId);
    // main here is checked out elsewhere with an edit in it, and stays that way throughout
    sh(w.repo, "git", "switch", "-q", "-c", "elsewhere");
    writeFileSync(join(w.repo, "README.md"), "edited on main\n");
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const { result } = await w.worktrees.land(wt.id, "add feature");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/main here was left where it is: main checkout is on 'elsewhere'/);
    expect((await git(origin, "log", "-1", "--format=%s", "main^2")).out).toBe("add feature");
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true });
    expect(readFileSync(join(w.repo, "README.md"), "utf8")).toBe("edited on main\n");
    expect((await git(w.repo, "branch", "--show-current")).out).toBe("elsewhere");
    // main cleared: its own pull takes the landing, and the row stays landed
    sh(w.repo, "git", "checkout", "-q", "--", "README.md");
    sh(w.repo, "git", "switch", "-q", "main");
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    expect((await w.worktrees.pull(main.id)).ok).toBe(true);
    expect((await git(w.repo, "rev-parse", "main")).out).toBe((await git(origin, "rev-parse", "main")).out);
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBe(true);
  });

  test("the push route by squash lands one commit with the suggested message, from toyon's own branch or an adopted one", async () => {
    const repoId = await registered();
    const { origin } = await pushRoute(repoId);
    w.state.requireRepo(repoId).config.land = { route: "push", method: "squash" };
    const wt = await w.worktrees.create(repoId, "feature");
    for (const n of [1, 2]) {
      writeFileSync(join(wt.path, `f${n}.txt`), "x\n");
      sh(wt.path, "git", "add", "-A");
      sh(wt.path, "git", "commit", "-qm", `step ${n}`);
    }
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    w.worktrees.setLanding(wt.id, {
      at: 1,
      check: "none",
      ready: true,
      subject: "add the feature",
      body: "Two steps.",
      fingerprint: "f",
    });
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("squashed onto main and pushed; main here pulled it");
    expect((await git(origin, "log", "--format=%s", "-n", "3")).out.split("\n")).toEqual(["add the feature", "init"]);
    expect((await git(origin, "log", "-1", "--format=%b")).out).toBe("Two steps.");
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(origin, "rev-parse", "main")).out);
    // the two commits it carried are kept under the landing's ref; the mark says what main got
    expect(w.state.worktree(wt.id)?.lands).toMatchObject([{ tip, subjects: ["add the feature"] }]);
    expect((await git(w.repo, "rev-parse", `refs/toyon/lands/${wt.id}/0`)).out).toBe(tip);
    // an adopted branch is squashed from a detached base and keeps its own commits
    sh(w.repo, "git", "branch", "theirs");
    const adopted = await w.worktrees.openRef(repoId, "branch", "theirs");
    for (const n of [1, 2]) {
      writeFileSync(join(adopted.path, `theirs${n}.txt`), "t\n");
      sh(adopted.path, "git", "add", "-A");
      sh(adopted.path, "git", "commit", "-qm", `theirs ${n}`);
    }
    const theirs = (await git(adopted.path, "rev-parse", "HEAD")).out;
    w.worktrees.setLanding(adopted.id, { at: 1, check: "none", ready: true, subject: "add theirs", fingerprint: "f" });
    expect((await w.worktrees.land(adopted.id)).result.ok).toBe(true);
    expect((await git(origin, "log", "-1", "--format=%s", "main")).out).toBe("add theirs");
    expect((await git(origin, "log", "-1", "--format=%P", "main")).out.split(" ")).toHaveLength(1);
    expect((await git(adopted.path, "rev-parse", "HEAD")).out).toBe(theirs);
    expect((await git(adopted.path, "branch", "--show-current")).out).toBe("theirs");
    expect(w.state.worktree(adopted.id)).toMatchObject({ landed: true });
  });

  test("the push route finds its work on origin already and lands the row without a push", async () => {
    const repoId = await registered();
    const { origin, other } = await pushRoute(repoId);
    w.state.requireRepo(repoId).config.land = { route: "push", method: "squash" };
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-qm", "add feature");
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    // a hand pushed the branch's own commit onto origin's main, hash and all: the rebase drops
    // it, and a squash of nothing would refuse
    sh(other, "git", "fetch", "-q", wt.path, wt.branch);
    sh(other, "git", "merge", "-q", "--ff-only", "FETCH_HEAD");
    sh(other, "git", "push", "-q", "origin", "main");
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("origin's main has this work already; main here pulled it");
    expect((await git(origin, "rev-parse", "main")).out).toBe(tip);
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe(tip);
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true });
    expect(w.state.worktree(wt.id)?.lands).toHaveLength(1);
  });

  test("the push route names its steps", async () => {
    const repoId = await registered();
    const { other } = await pushRoute(repoId);
    const wt = await w.worktrees.create(repoId, "feature");
    const seen: Array<string | undefined> = [];
    w.hub.on("worktreesChanged", () => {
      const out = w.worktrees.shippingOf(wt.id);
      if (out && (seen.length === 0 || seen.at(-1) !== out.step)) seen.push(out.step);
    });
    sh(other, "git", "commit", "-q", "--allow-empty", "-m", "elsewhere");
    sh(other, "git", "push", "-q", "origin", "main");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect((await w.worktrees.land(wt.id, "add feature")).result.ok).toBe(true);
    expect(seen).toEqual([
      undefined,
      "committing",
      "fetching origin/main",
      "rebasing onto origin/main",
      "merging into origin/main",
      "pushing main",
    ]);
  });

  test("the pr route refuses without an origin", async () => {
    const repoId = await registered();
    await setRoute(repoId, "pr");
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const { result } = await w.worktrees.land(wt.id, "add feature");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no 'origin' remote");
    // the commit stood: the work is safer committed
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
  });

  /** a bare origin with main on it, and a second clone as the hands GitHub and other people are */
  const withOrigin = async (repoId: string) => {
    const origin = join(w.repo, "..", "origin.git");
    sh(w.repo, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(w.repo, "git", "remote", "add", "origin", origin);
    sh(w.repo, "git", "push", "-q", "-u", "origin", "main");
    await setRoute(repoId, "pr");
    const other = join(w.repo, "..", "other");
    sh(w.repo, "git", "clone", "-q", origin, other);
    sh(other, "git", "config", "user.email", "o@o");
    sh(other, "git", "config", "user.name", "o");
    return { origin, other };
  };
  /** GitHub squash-merges the branch onto origin's main; main here is not pulled */
  const squashedOnOrigin = (other: string, from: string, branch: string) => {
    sh(other, "git", "fetch", "-q", from, branch);
    sh(other, "git", "merge", "-q", "--squash", "FETCH_HEAD");
    sh(other, "git", "commit", "-q", "-m", "add feature (#1)");
    sh(other, "git", "push", "-q", "origin", "main");
  };

  test("the pr route measures the branch against origin's main: a commit merged there is landed, not opened again", async () => {
    const repoId = await registered();
    const { origin, other } = await withOrigin(repoId);
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-q", "-m", "add feature");
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    // someone else's commit went in first, then the squash; main here still trails both
    sh(other, "git", "commit", "-q", "--allow-empty", "-m", "elsewhere");
    squashedOnOrigin(other, wt.path, wt.branch);
    const before = (await git(w.repo, "rev-parse", "main")).out;
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("origin's main has this work already");
    // main here followed origin, the branch restarted from it, the landing is on the record, and
    // nothing went up: no branch on origin, so no PR could have been opened on it
    const main = (await git(w.repo, "rev-parse", "main")).out;
    expect(main).toBe((await git(origin, "rev-parse", "main")).out);
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe(main);
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true });
    expect(w.state.worktree(wt.id)?.lands).toEqual([
      { base: before, tip, at: expect.any(Number), subjects: ["add feature"] },
    ]);
    expect((await git(origin, "branch", "--list", wt.branch)).out).toBe("");
  });

  test("a PR merged while main here cannot follow is landed at once; main follows when it can", async () => {
    const repoId = await registered();
    const { origin, other } = await withOrigin(repoId);
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-q", "-m", "add feature");
    sh(wt.path, "git", "push", "-q", "-u", "origin", wt.branch);
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    const before = (await git(w.repo, "rev-parse", "main")).out;
    const pr7 = { number: 7, url: "https://x/pull/7", title: "Add the feature" };
    w.worktrees.setPr(wt.id, { ...pr7, state: "open", at: 1 });
    squashedOnOrigin(other, origin, wt.branch);
    // GitHub's answer comes while a file on main stands in the fast-forward's way: the one the
    // squash on origin adds, started here too and never committed
    writeFileSync(join(w.repo, "feature.txt"), "started here too\n");
    w.worktrees.setPr(wt.id, { ...pr7, state: "merged", at: 2 });
    const r = await w.worktrees.prMerged(wt.id);
    // the merge on GitHub is the landing: the record has it and the branch restarted from main
    // here, which stayed where it was and says why; the branch on origin is untouched
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^PR #7 merged; main here was left where it is: .*would overwrite \(feature\.txt\)/);
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true, pr: { number: 7, state: "merged" } });
    // what landed is the PR, by its title: GitHub landed it by its own method and under that name
    expect(w.state.worktree(wt.id)?.lands).toEqual([
      { base: before, tip, at: expect.any(Number), pr: 7, subjects: ["Add the feature"] },
    ]);
    // the poll's word on the row carries the mark too
    expect(w.agents.get(wt.id)!.recorded.at(-1)).toMatchObject({
      type: "landed",
      mark: { pr: 7, subjects: ["Add the feature"] },
    });
    expect((await git(w.repo, "rev-parse", "main")).out).toBe(before);
    // the base is origin's main, which the PR landed on: the branch restarts from there, and
    // main here standing still hides none of it from the row
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(origin, "rev-parse", "main")).out);
    expect((await git(origin, "rev-parse", wt.branch)).out).toBe(tip);
    expect((await w.worktrees.trunks())[repoId]).toMatchObject({ stale: "dirty" });
    // a press now is not a second PR: the rebase onto origin finds nothing to send up, and the
    // landing is recorded once
    const again = await w.worktrees.land(wt.id);
    expect(again.result.ok).toBe(true);
    expect(again.result.message).toContain("main here was left where it is");
    expect(w.state.worktree(wt.id)?.lands).toHaveLength(1);
    // the file out of the way: main's own pull takes the merge, and the row stays landed
    rmSync(join(w.repo, "feature.txt"));
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    expect((await w.worktrees.pull(main.id)).ok).toBe(true);
    expect((await git(w.repo, "rev-parse", "main")).out).toBe((await git(origin, "rev-parse", "main")).out);
    expect(w.state.worktree(wt.id)?.landed).toBe(true);
  });

  test("an adopted branch squashed on GitHub stays landed, PR and all, until a new commit", async () => {
    const repoId = await registered();
    const { origin, other } = await withOrigin(repoId);
    sh(w.repo, "git", "branch", "theirs");
    const wt = await w.worktrees.openRef(repoId, "branch", "theirs");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-q", "-m", "add feature");
    sh(wt.path, "git", "push", "-q", "-u", "origin", "theirs");
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    w.worktrees.setPr(wt.id, { number: 7, url: "https://x/pull/7", state: "open", at: 1 });
    squashedOnOrigin(other, origin, "theirs");
    w.worktrees.setPr(wt.id, { number: 7, url: "https://x/pull/7", state: "merged", at: 2 });
    const landedIds: string[] = [];
    w.hub.on("landed", (id) => landedIds.push(id));
    expect((await w.worktrees.prMerged(wt.id)).ok).toBe(true);
    // the poll's landing reaches the hub as a press's does
    expect(landedIds).toEqual([wt.id]);
    // the branch keeps its own commit, so it reads as ahead of origin's main for good; the
    // landed tip is what says the work is there
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe(tip);
    expect(w.state.worktree(wt.id)?.lands).toMatchObject([{ tip, pr: 7 }]);
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ ahead: 1, behind: 1 });
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true, pr: { number: 7, state: "merged" } });
    // a second poll records nothing more
    expect((await w.worktrees.prMerged(wt.id)).ok).toBe(true);
    expect(w.state.worktree(wt.id)?.lands).toHaveLength(1);
    // new work past the landing: not landed, and the PR is history
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-q", "-m", "more");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
    expect(w.state.worktree(wt.id)?.pr).toBeUndefined();
  });

  test("a merged PR whose commits the base already has still records the landing", async () => {
    const repoId = await registered();
    const { origin, other } = await withOrigin(repoId);
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-q", "-m", "add feature");
    sh(wt.path, "git", "push", "-q", "-u", "origin", wt.branch);
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    const before = (await git(origin, "rev-parse", "main")).out;
    w.worktrees.setPr(wt.id, { number: 7, url: "https://x/pull/7", state: "open", at: 1 });
    // GitHub takes the branch as it is (a rebase merge with nothing to rebase), and the trunk's
    // own fetch sees origin's main move before the poll hears of the merge
    sh(other, "git", "fetch", "-q", "origin", wt.branch);
    sh(other, "git", "merge", "-q", "--ff-only", "FETCH_HEAD");
    sh(other, "git", "push", "-q", "origin", "main");
    sh(w.repo, "git", "fetch", "-q");
    w.worktrees.setPr(wt.id, { number: 7, url: "https://x/pull/7", state: "merged", at: 2 });
    expect((await w.worktrees.prMerged(wt.id)).ok).toBe(true);
    // a PR with no title on the record (gh never answered) falls back to the branch's own commits
    expect(w.state.worktree(wt.id)?.lands).toEqual([
      { base: before, tip, at: expect.any(Number), pr: 7, subjects: ["add feature"] },
    ]);
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true });
  });

  test("a merged PR with no commits of its own to read still records its title as what landed", async () => {
    const repoId = await registered();
    await withOrigin(repoId);
    const wt = await w.worktrees.create(repoId, "feature");
    // nothing committed here: no range against the base, and no reflog of the branch's own
    // commits, so the record holds the tip alone and the PR's title says what it was
    w.worktrees.setPr(wt.id, { number: 9, url: "https://x/pull/9", state: "open", title: "add the thing", at: 1 });
    w.worktrees.setPr(wt.id, { number: 9, url: "https://x/pull/9", state: "merged", title: "add the thing", at: 2 });
    expect((await w.worktrees.prMerged(wt.id)).ok).toBe(true);
    const [mark] = w.state.worktree(wt.id)?.lands ?? [];
    expect(mark).toMatchObject({ pr: 9, subjects: ["add the thing"] });
    expect(mark?.base).toBe(mark?.tip ?? "x");
  });

  test("a merged PR lands a worktree with uncommitted edits without losing them", async () => {
    const repoId = await registered();
    const { origin, other } = await withOrigin(repoId);
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-q", "-m", "add feature");
    sh(wt.path, "git", "push", "-q", "-u", "origin", wt.branch);
    w.worktrees.setPr(wt.id, { number: 7, url: "https://x/pull/7", state: "open", at: 1 });
    squashedOnOrigin(other, origin, wt.branch);
    // mid-edit when GitHub's answer comes
    writeFileSync(join(wt.path, "README.md"), "half a thought\n");
    w.worktrees.setPr(wt.id, { number: 7, url: "https://x/pull/7", state: "merged", at: 2 });
    expect((await w.worktrees.prMerged(wt.id)).ok).toBe(true);
    // the branch restarted from origin's main with the edit still in the tree, and the row
    // waits on the edit before it reads as landed
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(origin, "rev-parse", "main")).out);
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("half a thought\n");
    expect(w.state.worktree(wt.id)?.lands).toHaveLength(1);
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
    sh(wt.path, "git", "checkout", "-q", "--", "README.md");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true, pr: { number: 7, state: "merged" } });
  });

  test("with a PR open, land pushes the work the PR is missing rather than merging under it", async () => {
    const repoId = await registered();
    const origin = join(w.repo, "..", "origin.git");
    sh(w.repo, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(w.repo, "git", "remote", "add", "origin", origin);
    sh(w.repo, "git", "push", "-q", "-u", "origin", "main");
    await setRoute(repoId, "pr");
    const wt = await w.worktrees.create(repoId, "feature");
    // the branch as the first press left it: on origin, tracking, with a PR open on it
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-q", "-m", "add feature");
    sh(wt.path, "git", "push", "-q", "-u", "origin", wt.branch);
    w.worktrees.setPr(wt.id, { number: 7, url: "https://x/pull/7", state: "open", at: 1 });
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ unpushed: 0 });
    // a commit by hand and an edit since: the count says what the PR lacks
    sh(wt.path, "git", "commit", "-q", "--allow-empty", "-m", "by hand");
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ unpushed: 1 });
    const { result } = await w.worktrees.land(wt.id, "add more");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("committed and pushed; PR #7 has the new commits");
    expect(result.url).toBe("https://x/pull/7");
    const pushed = (await git(origin, "log", "--format=%s", "-n", "3", wt.branch)).out.split("\n");
    expect(pushed).toEqual(["add more", "by hand", "add feature"]);
    expect(w.state.worktree(wt.id)?.pr).toMatchObject({ number: 7, state: "open" });
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ unpushed: 0 });
  });
});
