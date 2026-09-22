import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT, git } from "./exec.ts";
import { pushBranch } from "./land.ts";

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
