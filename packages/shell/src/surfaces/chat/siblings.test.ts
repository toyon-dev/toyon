import { describe, expect, test } from "bun:test";
import type { WorktreeStatus } from "@toyon/shared";
import { matchesSibling, siblingWorktrees } from "./siblings.ts";

const row = (id: string, repoId: string, kind: "main" | "worktree" | "spare", title = id): WorktreeStatus =>
  ({
    id,
    repoId,
    path: `/p/wt-${id}`,
    name: title,
    procs: [],
    agent: "idle",
    login: false,
    worktree: { id, repoId, path: `/p/wt-${id}`, branch: `toyon/${id}`, kind, title, createdAt: 0 },
  }) as unknown as WorktreeStatus;

describe("siblingWorktrees", () => {
  const rows = [
    row("main", "r1", "main"),
    row("a", "r1", "worktree", "Row a"),
    row("spare", "r1", "spare"),
    row("b", "r1", "worktree", "Row b"),
    row("c", "r2", "worktree"),
    {
      id: "found",
      repoId: "r1",
      path: "/p/found",
      name: "found",
      procs: [],
      agent: "idle",
      login: false,
    } as WorktreeStatus,
  ];

  test("the project's worktree rows, in the rail's order, less the one the message is in", () => {
    expect(siblingWorktrees(rows, "r1", "a")).toEqual([{ id: "b", title: "Row b", branch: "toyon/b", dir: "wt-b" }]);
    expect(siblingWorktrees(rows, "r1", null).map((w) => w.id)).toEqual(["a", "b"]);
  });

  test("main, the spare, a found worktree and another project's rows are not chats to point at", () => {
    expect(siblingWorktrees(rows, "r2", "c")).toEqual([]);
    expect(siblingWorktrees(rows, undefined, "a")).toEqual([]);
  });
});

describe("matchesSibling", () => {
  const w = { id: "108c905080", title: "Message flash bug", branch: "toyon/message-flash-bug", dir: "wt-108c" };

  test("the title typed as its slug, run together, or in part", () => {
    expect(matchesSibling("message-flash", w)).toBe(true);
    expect(matchesSibling("messageflash", w)).toBe(true);
    expect(matchesSibling("Flash", w)).toBe(true);
    expect(matchesSibling("flashbug", w)).toBe(true);
  });

  test("the branch, the id a transcript is named by, and the directory", () => {
    expect(matchesSibling("toyon/mess", w)).toBe(true);
    expect(matchesSibling("108c90", w)).toBe(true);
    expect(matchesSibling("wt-108c", w)).toBe(true);
  });

  test("nothing typed matches everything; the wrong letters match nothing", () => {
    expect(matchesSibling("", w)).toBe(true);
    expect(matchesSibling("-", w)).toBe(true);
    expect(matchesSibling("readme", w)).toBe(false);
  });
});
