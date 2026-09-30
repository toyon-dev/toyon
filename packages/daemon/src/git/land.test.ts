import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT, git } from "./exec.ts";
import { fastForwardFetched, landingCommit, landLocally, overwritten, pushBranch } from "./land.ts";

describe("overwritten", () => {
  test("names the files under git's two headers, and nothing from any other refusal", () => {
    const tracked =
      "error: Your local changes to the following files would be overwritten by merge:\n\ta\n\tsrc/b.ts\nPlease commit your changes or stash them before you merge.\nAborting\n";
    expect(overwritten(tracked)).toEqual(["a", "src/b.ts"]);
    const untracked =
      "error: The following untracked working tree files would be overwritten by merge:\n\tc\nPlease move or remove them before you merge.\nAborting\n";
    expect(overwritten(untracked)).toEqual(["c"]);
    expect(overwritten(`${tracked}${untracked}`)).toEqual(["a", "src/b.ts", "c"]);
    expect(overwritten("fatal: Not possible to fast-forward, aborting.\n")).toEqual([]);
    expect(overwritten("CONFLICT (content): Merge conflict in a\nAutomatic merge failed\n")).toEqual([]);
  });
});

describe("landLocally on a main with uncommitted files", () => {
  let t: ReturnType<typeof tmpRepo>;
  let wt: string;
  beforeEach(() => {
    t = tmpRepo();
    writeFileSync(join(t.repo, "version.txt"), "1.0\n");
    sh(t.repo, GIT, "add", "-A");
    sh(t.repo, GIT, "commit", "-q", "-m", "version");
    wt = join(dirname(t.repo), "wt");
    sh(t.repo, GIT, "worktree", "add", "-q", "-b", "feat", wt);
    writeFileSync(join(wt, "README.md"), "changed on feat\n");
    writeFileSync(join(wt, "new.txt"), "new on feat\n");
    sh(wt, GIT, "add", "-A");
    sh(wt, GIT, "commit", "-q", "-m", "feat");
  });
  afterEach(() => t.cleanup());

  test("files the branch never touches ride along, uncommitted, under a fast-forward or a merge", async () => {
    // a tracked edit and an untracked file, neither of which the branch rewrites
    writeFileSync(join(t.repo, "version.txt"), "1.1\n");
    writeFileSync(join(t.repo, "scratch.txt"), "scratch\n");
    const r = await landLocally(wt, "feat", t.repo, "main", "rebase", "");
    expect(r).toMatchObject({ ok: true, message: "main moved onto feat" });
    expect((await git(t.repo, "rev-parse", "main")).out).toBe((await git(wt, "rev-parse", "feat")).out);
    expect(readFileSync(join(t.repo, "README.md"), "utf8")).toBe("changed on feat\n");
    expect(readFileSync(join(t.repo, "version.txt"), "utf8")).toBe("1.1\n");
    expect(existsSync(join(t.repo, "scratch.txt"))).toBe(true);
    const status = (await git(t.repo, "status", "--porcelain")).out.split("\n").map((l) => l.trim());
    expect(status.sort()).toEqual(["?? scratch.txt", "M version.txt"]);
  });

  test("a merge commit rides the same way", async () => {
    writeFileSync(join(t.repo, "version.txt"), "1.1\n");
    const r = await landLocally(wt, "feat", t.repo, "main", "merge", "");
    expect(r).toMatchObject({ ok: true, message: "merged feat into main" });
    expect((await git(t.repo, "log", "-1", "--format=%s")).out).toBe("Merge branch 'feat'");
    expect(readFileSync(join(t.repo, "version.txt"), "utf8")).toBe("1.1\n");
  });

  test("an edit the landing would overwrite refuses it by name, and main stays as it was", async () => {
    writeFileSync(join(t.repo, "README.md"), "edited on main\n");
    writeFileSync(join(t.repo, "version.txt"), "1.1\n");
    const before = (await git(t.repo, "rev-parse", "main")).out;
    for (const method of ["rebase", "merge"] as const) {
      const r = await landLocally(wt, "feat", t.repo, "main", method, "");
      expect(r.ok).toBe(false);
      expect(r.message).toBe(
        "main has uncommitted files the landing would overwrite (README.md): commit or stash them there first",
      );
      expect((await git(t.repo, "rev-parse", "main")).out).toBe(before);
      expect(readFileSync(join(t.repo, "README.md"), "utf8")).toBe("edited on main\n");
      expect(existsSync(join(t.repo, ".git", "MERGE_HEAD"))).toBe(false);
    }
  });

  test("an untracked file the branch adds is in the way too", async () => {
    writeFileSync(join(t.repo, "new.txt"), "started on main\n");
    const r = await landLocally(wt, "feat", t.repo, "main", "rebase", "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("would overwrite (new.txt)");
    expect(readFileSync(join(t.repo, "new.txt"), "utf8")).toBe("started on main\n");
  });

  test("a squash wants main clean, since its recovery is a hard reset", async () => {
    writeFileSync(join(t.repo, "version.txt"), "1.1\n");
    const r = await landLocally(wt, "feat", t.repo, "main", "squash", "feat squashed");
    expect(r).toMatchObject({ ok: false, message: "main has uncommitted changes: commit or stash them there first" });
    expect(readFileSync(join(t.repo, "version.txt"), "utf8")).toBe("1.1\n");
  });
});

describe("fastForwardFetched on a main with uncommitted files", () => {
  let t: ReturnType<typeof tmpRepo>;
  let upstream: string;
  beforeEach(() => {
    t = tmpRepo();
    const origin = join(dirname(t.repo), "origin.git");
    sh(t.repo, GIT, "init", "-q", "--bare", "-b", "main", origin);
    sh(t.repo, GIT, "remote", "add", "origin", origin);
    sh(t.repo, GIT, "push", "-q", "-u", "origin", "main");
    const clone = join(dirname(t.repo), "clone");
    sh(dirname(t.repo), GIT, "clone", "-q", origin, clone);
    writeFileSync(join(clone, "README.md"), "moved on\n");
    sh(clone, GIT, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "-am", "upstream");
    sh(clone, GIT, "push", "-q", "origin", "main");
    upstream = sh(clone, GIT, "rev-parse", "HEAD");
    sh(t.repo, GIT, "fetch", "-q");
  });
  afterEach(() => t.cleanup());

  test("a file the pull does not touch rides along", async () => {
    writeFileSync(join(t.repo, "scratch.txt"), "scratch\n");
    const r = await fastForwardFetched(t.repo, "main");
    expect(r).toMatchObject({ ok: true, moved: true });
    expect((await git(t.repo, "rev-parse", "main")).out).toBe(upstream);
    expect((await git(t.repo, "status", "--porcelain")).out).toBe("?? scratch.txt");
  });

  test("an edit the pull would overwrite holds main where it is, named", async () => {
    writeFileSync(join(t.repo, "README.md"), "edited here\n");
    const r = await fastForwardFetched(t.repo, "main");
    expect(r).toMatchObject({
      ok: false,
      stale: "dirty",
      message: "main has uncommitted files the pull would overwrite (README.md): commit or stash them there first",
    });
    expect((await git(t.repo, "rev-parse", "main")).out).not.toBe(upstream);
    expect(readFileSync(join(t.repo, "README.md"), "utf8")).toBe("edited here\n");
  });
});

describe("pushBranch", () => {
  let t: ReturnType<typeof tmpRepo>;
  let origin: string;
  beforeEach(() => {
    t = tmpRepo();
    origin = join(dirname(t.repo), "origin.git");
    sh(t.repo, GIT, "init", "-q", "--bare", "-b", "main", origin);
    sh(t.repo, GIT, "remote", "add", "origin", origin);
    sh(t.repo, GIT, "push", "-q", "-u", "origin", "main");
    sh(t.repo, GIT, "checkout", "-q", "-b", "feat");
    sh(t.repo, GIT, "commit", "-q", "--allow-empty", "-m", "one");
  });
  afterEach(() => t.cleanup());

  test("pushes a new branch, then a rebased one over its own earlier push", async () => {
    expect(await pushBranch(t.repo, "feat")).toMatchObject({ ok: true, message: "pushed feat" });
    expect((await git(t.repo, "rev-parse", "--abbrev-ref", "feat@{u}")).out).toBe("origin/feat");
    sh(t.repo, GIT, "commit", "-q", "--amend", "--allow-empty", "-m", "one, reworded");
    expect((await pushBranch(t.repo, "feat")).ok).toBe(true);
    expect((await git(origin, "log", "-1", "--format=%s", "feat")).out).toBe("one, reworded");
  });

  test("a branch origin deleted since the last push is pushed again as a new one", async () => {
    expect((await pushBranch(t.repo, "feat")).ok).toBe(true);
    // the PR merged and GitHub deleted its head branch; nothing here fetched with --prune, so
    // origin/feat still names the old tip and git's own lease refuses the push as stale
    sh(origin, GIT, "update-ref", "-d", "refs/heads/feat");
    sh(t.repo, GIT, "commit", "-q", "--allow-empty", "-m", "two");
    const raw = await git(t.repo, "push", "--force-with-lease", "origin", "feat");
    expect(raw.ok).toBe(false);
    expect(raw.err).toContain("stale info");

    expect(await pushBranch(t.repo, "feat")).toMatchObject({ ok: true, message: "pushed feat" });
    expect((await git(origin, "log", "-1", "--format=%s", "feat")).out).toBe("two");
    expect((await git(t.repo, "rev-parse", "origin/feat")).out).toBe((await git(t.repo, "rev-parse", "feat")).out);
  });

  test("a branch someone else moved on origin is still refused", async () => {
    expect((await pushBranch(t.repo, "feat")).ok).toBe(true);
    const other = join(dirname(t.repo), "other");
    sh(dirname(t.repo), GIT, "clone", "-q", "-b", "feat", origin, other);
    sh(other, GIT, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "--allow-empty", "-m", "theirs");
    sh(other, GIT, "push", "-q", "origin", "feat");
    sh(t.repo, GIT, "commit", "-q", "--allow-empty", "-m", "two");
    const r = await pushBranch(t.repo, "feat");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("stale info");
    expect((await git(origin, "log", "-1", "--format=%s", "feat")).out).toBe("theirs");
  });
});

describe("landingCommit", () => {
  let t: ReturnType<typeof tmpRepo>;
  let feat = "";
  let main = "";
  beforeEach(() => {
    t = tmpRepo();
    sh(t.repo, GIT, "checkout", "-q", "-b", "feat");
    for (const n of [1, 2]) {
      writeFileSync(join(t.repo, `f${n}.txt`), "x\n");
      sh(t.repo, GIT, "add", "-A");
      sh(t.repo, GIT, "commit", "-q", "-m", `step ${n}`);
    }
    feat = sh(t.repo, GIT, "rev-parse", "HEAD");
    main = sh(t.repo, GIT, "rev-parse", "main");
  });
  afterEach(() => t.cleanup());
  const parent = async (sha: string) => (await git(t.repo, "rev-parse", `${sha}^1`)).out;
  const tree = async (ref: string) => (await git(t.repo, "rev-parse", `${ref}^{tree}`)).out;

  test("a merge commit sits on the base, carries the branch's tree, and leaves the branch as it was", async () => {
    const r = await landingCommit(t.repo, "feat", "main", "merge", "", true);
    expect(r.ok).toBe(true);
    expect(await parent(r.sha!)).toBe(main);
    expect((await git(t.repo, "rev-parse", `${r.sha}^2`)).out).toBe(feat);
    expect(await tree(r.sha!)).toBe(await tree("feat"));
    expect((await git(t.repo, "rev-parse", "feat")).out).toBe(feat);
    expect((await git(t.repo, "branch", "--show-current")).out).toBe("feat");
    expect((await git(t.repo, "status", "--porcelain")).out).toBe("");
  });

  test("a squash of toyon's own branch moves the branch itself onto one commit over the base", async () => {
    const r = await landingCommit(t.repo, "feat", "main", "squash", "the feature\n\nTwo steps.", true);
    expect(r.ok).toBe(true);
    expect(await parent(r.sha!)).toBe(main);
    expect(await tree(r.sha!)).toBe(await tree(feat));
    expect((await git(t.repo, "rev-parse", "feat")).out).toBe(r.sha!);
    expect((await git(t.repo, "log", "-1", "--format=%B")).out).toBe("the feature\n\nTwo steps.");
  });

  test("a squash of an adopted branch is made on a detached base and the branch keeps its commits", async () => {
    const r = await landingCommit(t.repo, "feat", "main", "squash", "the feature", false);
    expect(r.ok).toBe(true);
    expect(await parent(r.sha!)).toBe(main);
    expect(await tree(r.sha!)).toBe(await tree(feat));
    expect((await git(t.repo, "rev-parse", "feat")).out).toBe(feat);
    expect((await git(t.repo, "branch", "--show-current")).out).toBe("feat");
  });

  test("rebase is the branch as it is", async () => {
    expect(await landingCommit(t.repo, "feat", "main", "rebase", "", true)).toMatchObject({ ok: true, sha: feat });
  });

  test("a hook that refuses the landing commit leaves the branch as it was, checked out and clean", async () => {
    // named as the hooks path, since a global one would hide a hook written into .git/hooks
    const hooks = join(dirname(t.repo), "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\necho no >&2\nexit 1\n", { mode: 0o755 });
    sh(t.repo, GIT, "config", "core.hooksPath", hooks);
    for (const [method, own] of [
      ["merge", true],
      ["squash", false],
      ["squash", true],
    ] as const) {
      const r = await landingCommit(t.repo, "feat", "main", method, "m", own);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("refused");
      expect((await git(t.repo, "rev-parse", "feat")).out).toBe(feat);
      expect((await git(t.repo, "branch", "--show-current")).out).toBe("feat");
      expect((await git(t.repo, "status", "--porcelain")).out).toBe("");
    }
  });
});
