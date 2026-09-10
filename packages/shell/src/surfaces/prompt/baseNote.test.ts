import { describe, expect, test } from "bun:test";
import { baseNote, behindNote } from "./baseNote.ts";

describe("baseNote", () => {
  test("says nothing for a clean base, counted or not", () => {
    expect(baseNote("main", 0)).toBeNull();
    expect(baseNote("main", undefined)).toBeNull();
  });
  test("names the base and its count, singular and plural", () => {
    expect(baseNote("main", 1)).toBe("main has 1 uncommitted file; the new worktree starts from its last commit");
    expect(baseNote("sticky header", 3)).toBe(
      "sticky header has 3 uncommitted files; the new worktree starts from its last commit",
    );
  });
});

describe("behindNote", () => {
  test("nothing when level with the default branch", () => {
    expect(behindNote("main", 0)).toBeNull();
    expect(behindNote("main", undefined)).toBeNull();
  });
  test("counts the commits against the branch by name", () => {
    expect(behindNote("main", 1)).toBe("1 commit behind main");
    expect(behindNote("master", 12)).toBe("12 commits behind master");
  });
});
