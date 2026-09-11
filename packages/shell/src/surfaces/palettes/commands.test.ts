import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, RepoInfo, Theme } from "@toyon/shared";
import { buildCommands, type Command, type CommandState, commandHits, filterCommands } from "./commands.ts";

describe("buildCommands", () => {
  // the rows are keyed by id, so an id twice leaves a stale row behind when the list changes
  test("gives every command its own id, though the app and a worktree both have a terminal", () => {
    const repo = { id: "r", path: "/r", name: "r", defaultBranch: "main", config: {}, needsSetup: false } as RepoInfo;
    const wt = {
      id: "w1",
      repoId: "r",
      name: "feature",
      branch: "feature",
      path: "/r/wt/feature",
      worktree: {
        id: "w1",
        repoId: "r",
        title: "feature",
        branch: "toyon/feature",
        path: "/r/wt/feature",
        kind: "worktree",
        proxyPort: 1,
        createdAt: 0,
      },
      procs: [],
      agent: "idle",
      dirty: 0,
      ahead: 0,
      behind: 0,
    } as unknown as OwnedWorktree;
    const state = {
      picking: null,
      leftOpen: true,
      rightOpen: true,
      railOpen: true,
      termOpen: false,
      designOpen: false,
      themePrefs: { mode: "system", dark: "t", light: "t" },
      themes: [{ id: "t", name: "Night", kind: "dark" } as Theme],
      systemDark: true,
      rows: [wt],
      visible: [wt],
      activeId: "w1",
      activeRepoId: "r",
      repos: [repo],
      agents: [],
      defaultAgent: "claude",
      prefs: { recaps: "summarize" },
      shipping: {},
    } as unknown as CommandState;
    const ids = buildCommands(state, () => {}, null, wt, repo).map((c) => c.id);
    expect(ids).toContain("terminal");
    expect(ids).toContain("wt:terminal");
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

// The palette matcher's one rule: a character may only skip ahead to the start of a word, so a
// typo can't scavenge a match out of a long label. Everything else (ranking, hit positions for
// highlighting) follows from it.

const cmd = (label: string): Command => ({ id: label, label, run: () => {} });

describe("commandHits", () => {
  test("consecutive characters match in place", () => {
    expect(commandHits("Toggle changes", "tog")).toEqual([0, 1, 2]);
  });
  test("a skip lands only on a word start", () => {
    expect(commandHits("Toggle changes", "tc")).toEqual([0, 7]);
    // "e" occurs mid-word in "Toggle" but not at any word start after position 0
    expect(commandHits("Toggle changes", "te")).toBeNull();
  });
  test("punctuation opens a word", () => {
    expect(commandHits("light/dark mode…", "ld")).toEqual([0, 6]);
    expect(commandHits("switch to: main", "sm")).toEqual([0, 11]);
  });
  test("a typed space jumps to the next gap", () => {
    expect(commandHits("Toggle changes", "t c")).toEqual([0, 6, 7]);
  });
  test("case-insensitive", () => {
    expect(commandHits("Ship PR", "SP")).toEqual([0, 5]);
  });
  test("no match is null, not an empty list", () => {
    expect(commandHits("Ship PR", "x")).toBeNull();
  });
});

describe("filterCommands", () => {
  const cmds = [
    cmd("Toggle changes"),
    cmd("Toggle chat"),
    cmd("switch to you-ve-hit-your-session-limit"),
    cmd("theme…"),
  ];
  test("empty query keeps the order", () => {
    expect(filterCommands(cmds, "  ")).toBe(cmds);
  });
  test("the typo can't scavenge a match", () => {
    expect(filterCommands(cmds, "theem").map((c) => c.label)).toEqual([]);
  });
  test("exact prefix beats a scattered match, shorter label wins a tie", () => {
    expect(filterCommands(cmds, "toggle ch").map((c) => c.label)).toEqual(["Toggle chat", "Toggle changes"]);
  });
  test("word initials find the long label", () => {
    expect(filterCommands(cmds, "sy").map((c) => c.label)).toEqual(["switch to you-ve-hit-your-session-limit"]);
  });
});
