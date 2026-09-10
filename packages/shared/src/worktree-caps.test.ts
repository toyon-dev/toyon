import { describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "./model.ts";
import { canFold, canLand, canRemove, canRename, canSync, isMain } from "./worktree-caps.ts";

const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id: "w",
  repoId: "r",
  path: "/w",
  branch: "toyon/w",
  kind: "worktree",
  proxyPort: 1,
  title: "w",
  createdAt: 0,
  ...over,
});

describe("worktree capabilities", () => {
  test("main is the baseline: nothing is done to it", () => {
    const main = wt({ kind: "main", branch: "main" });
    expect(isMain(main)).toBe(true);
    expect(canRemove(main)).toBe(false);
    expect(canRename(main)).toBe(false);
    expect(canLand(main)).toBe(false);
    expect(canFold(main)).toBe(false);
  });

  test("a spare belongs to the pool, not to a person", () => {
    const spare = wt({ kind: "spare" });
    expect(canRemove(spare)).toBe(false);
    expect(canFold(spare)).toBe(false);
    expect(canLand(spare)).toBe(false);
  });

  test("a task toyon made can do everything", () => {
    const task = wt();
    expect(canRemove(task)).toBe(true);
    expect(canRename(task)).toBe(true);
    expect(canLand(task)).toBe(true);
    expect(canFold(task)).toBe(true);
  });

  test("an adopted worktree keeps the person's branch name, and everything else", () => {
    const adopted = wt({ branch: "editor-pane" });
    expect(canRename(adopted)).toBe(false);
    expect(canRemove(adopted)).toBe(true);
    expect(canLand(adopted)).toBe(true);
    expect(canFold(adopted)).toBe(true);
  });

  test("sync needs a branch nobody else holds, and never main", () => {
    expect(canSync({ branch: "feature" })).toBe(true);
    expect(canSync({ branch: "feature", worktree: wt({ branch: "feature" }) })).toBe(true);
    expect(canSync({})).toBe(false);
    expect(canSync({ branch: "feature", locked: true })).toBe(false);
    expect(canSync({ branch: "main", worktree: wt({ kind: "main", branch: "main" }) })).toBe(false);
  });

  test("a worktree opened to review a PR is not landed here", () => {
    const review = wt({ branch: "pr/42", from: { kind: "pr", ref: "42", pr: { number: 42, url: "u", title: "t" } } });
    expect(canLand(review)).toBe(false);
    expect(canRemove(review)).toBe(true);
    // a branch pulled in from the remote is ordinary work once it is here
    expect(canLand(wt({ branch: "feature", from: { kind: "remote", ref: "feature" } }))).toBe(true);
  });
});
