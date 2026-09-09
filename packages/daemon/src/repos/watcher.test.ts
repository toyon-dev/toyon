import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
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
