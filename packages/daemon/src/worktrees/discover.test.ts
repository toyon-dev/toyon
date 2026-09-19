import { describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "@toyon/shared";
import type { GitWorktree } from "../git/worktrees.ts";
import { discoveredId, subtractKnown } from "./discover.ts";

const listed = (path: string, over: Partial<GitWorktree> = {}): GitWorktree => ({
  path,
  detached: false,
  bare: false,
  locked: false,
  ...over,
});

const known = (path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id: "w1",
  repoId: "r1",
  path,
  branch: "toyon/x",
  kind: "worktree",
  proxyPort: 4000,
  title: "x",
  createdAt: 0,
  ...over,
});

describe("subtractKnown", () => {
  test("keeps what toyon does not have, drops what it does", () => {
    const rows = subtractKnown(
      "r1",
      [listed("/repo", { branch: "main" }), listed("/wt/foreign", { branch: "feature" })],
      [known("/repo", { kind: "main", branch: "main" })],
    );
    expect(rows).toEqual([
      { id: discoveredId("/wt/foreign"), repoId: "r1", name: "feature", path: "/wt/foreign", branch: "feature" },
    ]);
  });

  test("the pre-warmed spare is toyon's, not a stray worktree", () => {
    const rows = subtractKnown(
      "r1",
      [listed("/home/.toyon/worktrees.noindex/app/wt-a4a3", { detached: true })],
      [known("/home/.toyon/worktrees.noindex/app/wt-a4a3", { kind: "spare" })],
    );
    expect(rows).toEqual([]);
  });

  test("a claimed spare is matched through its branch symlink too", () => {
    const rows = subtractKnown(
      "r1",
      [listed("/wt/wt-7bb1", { branch: "toyon/add-page" })],
      [known("/wt/wt-7bb1", { linkPath: "/wt/add-page" })],
    );
    expect(rows).toEqual([]);
  });

  test("worktrees of every repo count as known, not just the one being scanned", () => {
    // registering a worktree as its own project should not then offer it back for adoption
    const rows = subtractKnown(
      "r1",
      [listed("/projects/side", { branch: "side" })],
      [known("/projects/side", { repoId: "r2", kind: "main" })],
    );
    expect(rows).toEqual([]);
  });

  // only macOS makes /tmp a symlink to /private/tmp; elsewhere they are two different directories
  test.if(process.platform === "darwin")("/tmp and /private/tmp are the same worktree on macOS", () => {
    // canonical() resolves the deepest existing ancestor, and /tmp is a symlink to /private/tmp,
    // so state.json's spelling and git's need not agree for the subtraction to work
    const rows = subtractKnown("r1", [listed("/tmp/wt-a", { branch: "a" })], [known("/private/tmp/wt-a")]);
    expect(rows).toEqual([]);
  });

  test("a detached worktree is named by its directory", () => {
    const rows = subtractKnown("r1", [listed("/wt/loose-head", { detached: true })], []);
    expect(rows[0]?.name).toBe("loose-head");
    expect(rows[0]?.branch).toBeUndefined();
  });

  test("a lock is carried through with its reason", () => {
    const rows = subtractKnown(
      "r1",
      [listed("/wt/held", { branch: "held", locked: true, lockReason: "claude session dsys (pid 900)" })],
      [],
    );
    expect(rows[0]?.locked).toBe(true);
    expect(rows[0]?.lockReason).toBe("claude session dsys (pid 900)");
  });

  test("a lock with no reason is still a lock", () => {
    const rows = subtractKnown("r1", [listed("/wt/held", { branch: "held", locked: true })], []);
    expect(rows[0]?.locked).toBe(true);
    expect(rows[0]?.lockReason).toBeUndefined();
  });

  test("bare and prunable entries are not places work happens", () => {
    const rows = subtractKnown(
      "r1",
      [
        listed("/repo.git", { bare: true }),
        listed("/wt/gone", { branch: "gone", prunable: "gitdir file points elsewhere" }),
      ],
      [],
    );
    expect(rows).toEqual([]);
  });

  test("nothing listed, nothing discovered", () => {
    expect(subtractKnown("r1", [], [])).toEqual([]);
  });
});
