import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT, git } from "./exec.ts";
import { landingCommit, pushBranch } from "./land.ts";

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
