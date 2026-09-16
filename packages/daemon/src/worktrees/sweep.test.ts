import { describe, expect, test } from "bun:test";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { ArchiveSweep, archiveAfterFrom, type SweepDeps } from "./sweep.ts";

const HOUR = 60 * 60_000;

const task = (id: string, sent: number, w: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  branch: `toyon/${id}`,
  kind: "worktree",
  proxyPort: 1,
  title: id,
  createdAt: 0,
  promptedAt: sent,
  viewedAt: 0,
  lastTurn: { at: 1, end: "done", facts: { turns: 1, edits: 0, toolErrors: 0 } },
  seenAt: 2,
  ...w,
});

function make(worktrees: WorktreeInfo[], over: Partial<SweepDeps> = {}) {
  const archived: Array<[string, string | undefined]> = [];
  const asked: string[] = [];
  const counts = new Map<string, { dirty: number; ahead: number }>();
  const sweep = new ArchiveSweep({
    state: { repos: [{ id: "r" } as RepoInfo], worktrees },
    viewed: () => false,
    busy: () => false,
    drafts: { has: () => false },
    worktrees: {
      archiveWorktree: async (id, opts = {}) => {
        archived.push([id, opts.reason]);
        return null;
      },
      freshCounts: async (id) => {
        asked.push(id);
        return counts.get(id) ?? { dirty: 0, ahead: 0 };
      },
    },
    now: () => 10 * HOUR,
    setInterval: () => null,
    ...over,
  });
  return { sweep, archived, asked, counts };
}

const newer = [1, 2, 3, 4, 5].map((n) => task(`new${n}`, 100 + n, { viewedAt: 9 * HOUR }));

describe("ArchiveSweep", () => {
  test("archives what the rule lets go with its reason, and asks git only about those rows", async () => {
    const { sweep, archived, asked } = make([task("old", 1), ...newer]);
    await sweep.sweep();
    expect(archived).toEqual([["old", "no changes, not opened in 2h"]]);
    expect(asked).toEqual(["old"]);
  });

  test("git saying there is work keeps the row", async () => {
    const { sweep, archived, counts } = make([task("old", 1), ...newer]);
    counts.set("old", { dirty: 2, ahead: 0 });
    await sweep.sweep();
    expect(archived).toEqual([]);
  });

  test("a draft in its box keeps it", async () => {
    const { sweep, archived } = make([task("old", 1), ...newer], { drafts: { has: (id) => id === "old" } });
    await sweep.sweep();
    expect(archived).toEqual([]);
  });

  test("a row someone sends to while git is asked is kept: the rule runs again once git has answered", async () => {
    let sent = false;
    const { sweep, archived } = make([task("old", 1), ...newer], {
      busy: (id) => id === "old" && sent,
      worktrees: {
        archiveWorktree: async (id, opts = {}) => {
          archived.push([id, opts.reason]);
          return null;
        },
        freshCounts: async () => {
          sent = true;
          return { dirty: 0, ahead: 0 };
        },
      },
    });
    await sweep.sweep();
    expect(archived).toEqual([]);
  });

  test("off archives nothing", async () => {
    const { sweep, archived } = make([task("old", 1), ...newer], { afterMs: null });
    await sweep.sweep();
    expect(archived).toEqual([]);
  });

  test("TOYON_ARCHIVE_AFTER_MS reads a number, off, or falls back to two hours", () => {
    expect(archiveAfterFrom("5000")).toBe(5000);
    expect(archiveAfterFrom("off")).toBeNull();
    expect(archiveAfterFrom(undefined)).toBe(2 * HOUR);
    expect(archiveAfterFrom("soon")).toBe(2 * HOUR);
  });
});
