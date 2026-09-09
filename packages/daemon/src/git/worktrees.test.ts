import { describe, expect, test } from "bun:test";
import { parseWorktreeList } from "./worktrees.ts";

describe("parseWorktreeList", () => {
  test("main checkout, linked worktree and detached", () => {
    const out = [
      "worktree /Users/k/Projects/toyon",
      "HEAD 81ac53397d3dd3583f21b6cdda95e4c768c71090",
      "branch refs/heads/main",
      "",
      "worktree /Users/k/Projects/toyon-design-grid",
      "HEAD 22fe40cba0c1893735e14640d9551228e6697ce3",
      "branch refs/heads/design-grid",
      "",
      "worktree /Users/k/.toyon/worktrees.noindex/toyon/wt-a4a3",
      "HEAD 81ac53397d3dd3583f21b6cdda95e4c768c71090",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      {
        path: "/Users/k/Projects/toyon",
        head: "81ac53397d3dd3583f21b6cdda95e4c768c71090",
        branch: "main",
        detached: false,
        bare: false,
        locked: false,
      },
      {
        path: "/Users/k/Projects/toyon-design-grid",
        head: "22fe40cba0c1893735e14640d9551228e6697ce3",
        branch: "design-grid",
        detached: false,
        bare: false,
        locked: false,
      },
      {
        path: "/Users/k/.toyon/worktrees.noindex/toyon/wt-a4a3",
        head: "81ac53397d3dd3583f21b6cdda95e4c768c71090",
        detached: true,
        bare: false,
        locked: false,
      },
    ]);
  });

  test("a lock carries its reason, and a bare lock is still a lock", () => {
    const out = [
      "worktree /Users/k/Projects/toyon/.claude/worktrees/agent-asks",
      "HEAD fd3e2b4b067c58321f82a6d35ebfc58b491df9f0",
      "branch refs/heads/worktree-agent-asks",
      "locked claude session agent-asks (pid 18900 start Mon Sep 7 19:40:13 2026)",
      "",
      "worktree /Users/k/Projects/other",
      "HEAD fd3e2b4b067c58321f82a6d35ebfc58b491df9f0",
      "branch refs/heads/other",
      "locked",
      "",
    ].join("\n");
    const [asks, other] = parseWorktreeList(out);
    expect(asks?.locked).toBe(true);
    expect(asks?.lockReason).toBe("claude session agent-asks (pid 18900 start Mon Sep 7 19:40:13 2026)");
    expect(other?.locked).toBe(true);
    expect(other?.lockReason).toBeUndefined();
  });

  test("bare and prunable entries", () => {
    const out = [
      "worktree /Users/k/bare.git",
      "bare",
      "",
      "worktree /Users/k/gone",
      "HEAD abc123",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    const [bare, gone] = parseWorktreeList(out);
    expect(bare).toEqual({ path: "/Users/k/bare.git", detached: false, bare: true, locked: false });
    expect(gone?.prunable).toBe("gitdir file points to non-existent location");
  });

  test("quoted paths and lock reasons are unquoted", () => {
    const out = [
      'worktree "/Users/k/with space"',
      "HEAD abc123",
      "branch refs/heads/main",
      'locked "held by \\"someone\\""',
      "",
    ].join("\n");
    const [wt] = parseWorktreeList(out);
    expect(wt?.path).toBe("/Users/k/with space");
    expect(wt?.lockReason).toBe('held by "someone"');
  });

  test("a branch name containing a slash keeps everything after refs/heads/", () => {
    const out = ["worktree /Users/k/w", "HEAD abc123", "branch refs/heads/toyon/add-about-page", ""].join("\n");
    expect(parseWorktreeList(out)[0]?.branch).toBe("toyon/add-about-page");
  });

  test("no trailing blank line still closes the last record", () => {
    const out = "worktree /Users/k/w\nHEAD abc123\nbranch refs/heads/main";
    expect(parseWorktreeList(out)).toHaveLength(1);
  });

  test("an unknown attribute from a newer git is ignored, not mistaken for a record", () => {
    const out = ["worktree /Users/k/w", "HEAD abc123", "branch refs/heads/main", "somethingnew value", ""].join("\n");
    expect(parseWorktreeList(out)).toHaveLength(1);
  });

  test("empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
