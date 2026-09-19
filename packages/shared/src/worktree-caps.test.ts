import { describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "./model.ts";
import { canArchive, canGraft, canLand, canRename, canSync, isLead, isMain, isProvisional } from "./worktree-caps.ts";

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
    expect(canArchive(main)).toBe(false);
    expect(canRename(main)).toBe(false);
    expect(canLand(main)).toBe(false);
    expect(canGraft(main)).toBe(false);
  });

  test("a spare belongs to the pool, not to a person", () => {
    const spare = wt({ kind: "spare" });
    expect(canArchive(spare)).toBe(false);
    expect(canGraft(spare)).toBe(false);
    expect(canLand(spare)).toBe(false);
    expect(canSync({ branch: "main", worktree: spare })).toBe(false);
  });

  test("the lead is the provisional row, or main when there is none", () => {
    expect(isProvisional(wt({ kind: "spare" }))).toBe(true);
    expect(isProvisional(wt({ kind: "main" }))).toBe(false);
    expect(isLead(wt({ kind: "spare" }))).toBe(true);
    expect(isLead(wt({ kind: "main" }))).toBe(true);
    expect(isLead(wt())).toBe(false);
  });

  test("a task toyon made can do everything", () => {
    const task = wt();
    expect(canArchive(task)).toBe(true);
    expect(canRename(task)).toBe(true);
    expect(canLand(task)).toBe(true);
    expect(canGraft(task)).toBe(true);
  });

  test("an adopted worktree keeps the person's branch name, and everything else", () => {
    const adopted = wt({ branch: "editor-pane" });
    expect(canRename(adopted)).toBe(false);
    expect(canArchive(adopted)).toBe(true);
    expect(canLand(adopted)).toBe(true);
    expect(canGraft(adopted)).toBe(true);
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
    expect(canArchive(review)).toBe(true);
    // a branch pulled in from the remote is ordinary work once it is here
    expect(canLand(wt({ branch: "feature", from: { kind: "remote", ref: "feature" } }))).toBe(true);
  });
});
