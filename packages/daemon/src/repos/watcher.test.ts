import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT } from "../git/exec.ts";
import { watchDefaultBranch, watchWorktreeDir } from "./watcher.ts";

// The watcher turns noisy .git fs events into one "main moved" per ref change, confirmed by
// rev-parse, and stays silent for churn that leaves the ref where it was.

let t: ReturnType<typeof tmpRepo>;
beforeAll(() => {
  t = tmpRepo();
});
afterAll(() => t.cleanup());

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("a commit on main fires once; index churn without a ref move does not", async () => {
  let moves = 0;
  const stop = watchDefaultBranch(t.repo, "main", () => moves++);
  await settle(300); // baseline rev-parse
  writeFileSync(join(t.repo, "a.txt"), "a\n");
  sh(t.repo, GIT, "add", "-A"); // touches .git/index only
  await settle(1500);
  expect(moves).toBe(0);
  sh(t.repo, GIT, "commit", "-q", "-m", "a");
  await settle(2500);
  expect(moves).toBe(1);
  stop();
  sh(t.repo, GIT, "commit", "-q", "--allow-empty", "-m", "after stop");
  await settle(1500);
  expect(moves).toBe(1);
}, 15000);

test("worktrees added and removed outside toyon each fire; commits do not", async () => {
  const w = tmpRepo();
  try {
    let changes = 0;
    const stop = watchWorktreeDir(w.repo, () => changes++);
    await settle(400); // the common-git-dir rev-parse, then the watchers arm

    // the first one also creates .git/worktrees itself
    const first = join(dirname(w.repo), "wt-one");
    sh(w.repo, GIT, "worktree", "add", "-q", "-b", "one", first, "main");
    await settle(800);
    expect(changes).toBeGreaterThan(0);

    // the case a watch on .git alone would miss: .git/worktrees already exists, so adding a
    // second worktree only changes entries one level down
    const before = changes;
    const second = join(dirname(w.repo), "wt-two");
    sh(w.repo, GIT, "worktree", "add", "-q", "-b", "two", second, "main");
    await settle(800);
    expect(changes).toBeGreaterThan(before);

    const beforeRemove = changes;
    sh(w.repo, GIT, "worktree", "remove", "--force", second);
    await settle(800);
    expect(changes).toBeGreaterThan(beforeRemove);

    // an ordinary commit is not a worktree change
    const beforeCommit = changes;
    sh(w.repo, GIT, "commit", "-q", "--allow-empty", "-m", "unrelated");
    await settle(800);
    expect(changes).toBe(beforeCommit);

    stop();
    const third = join(dirname(w.repo), "wt-three");
    sh(w.repo, GIT, "worktree", "add", "-q", "-b", "three", third, "main");
    await settle(800);
    expect(changes).toBe(beforeCommit);
  } finally {
    w.cleanup();
  }
}, 20000);

test("origin's main moving is an upstream move, a commit here a local one", async () => {
  const u = tmpRepo();
  try {
    const bare = join(dirname(u.repo), "origin.git");
    sh(u.repo, GIT, "init", "-q", "--bare", "-b", "main", bare);
    sh(u.repo, GIT, "remote", "add", "origin", bare);
    sh(u.repo, GIT, "push", "-q", "-u", "origin", "main");
    const moves: string[] = [];
    const stop = watchDefaultBranch(u.repo, "main", (which) => moves.push(which));
    await settle(400); // baseline reads, and the watchers arm
    // someone else pushes: origin moved, nothing here did, and a fetch is how this repo learns
    const clone = join(dirname(u.repo), "clone");
    sh(dirname(u.repo), GIT, "clone", "-q", bare, clone);
    sh(clone, GIT, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "--allow-empty", "-m", "theirs");
    sh(clone, GIT, "push", "-q", "origin", "main");
    sh(u.repo, GIT, "fetch", "-q");
    await settle(2500);
    expect(moves).toEqual(["upstream"]);
    sh(u.repo, GIT, "commit", "-q", "--allow-empty", "-m", "mine");
    await settle(2500);
    expect(moves).toEqual(["upstream", "local"]);
    stop();
  } finally {
    u.cleanup();
  }
}, 20000);

test("a remote never fetched is watched from its first fetch, which is itself an upstream move", async () => {
  const u = tmpRepo();
  try {
    // origin populated from a copy and tracking configured by hand: no refs/remotes exists yet
    const bare = join(dirname(u.repo), "origin.git");
    sh(dirname(u.repo), GIT, "clone", "-q", "--bare", u.repo, bare);
    sh(u.repo, GIT, "remote", "add", "origin", bare);
    sh(u.repo, GIT, "config", "branch.main.remote", "origin");
    sh(u.repo, GIT, "config", "branch.main.merge", "refs/heads/main");
    expect(existsSync(join(u.repo, ".git", "refs", "remotes"))).toBe(false);
    const moves: string[] = [];
    const stop = watchDefaultBranch(u.repo, "main", (which) => moves.push(which));
    await settle(400);
    sh(u.repo, GIT, "fetch", "-q");
    await settle(2500);
    expect(moves).toEqual(["upstream"]);
    const clone = join(dirname(u.repo), "clone");
    sh(dirname(u.repo), GIT, "clone", "-q", bare, clone);
    sh(clone, GIT, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "--allow-empty", "-m", "theirs");
    sh(clone, GIT, "push", "-q", "origin", "main");
    sh(u.repo, GIT, "fetch", "-q");
    await settle(2500);
    expect(moves).toEqual(["upstream", "upstream"]);
    stop();
  } finally {
    u.cleanup();
  }
}, 20000);
