import { describe, expect, test } from "bun:test";
import { forgetQuestion } from "./project.ts";

describe("forget project", () => {
  test("with nothing to archive the question says only what the forget itself does", () => {
    expect(forgetQuestion("r", 0)).toStartWith("Forget r?\n\nIts procs stop,");
  });

  test("names the worktrees it archives on the way", () => {
    expect(forgetQuestion("r", 1)).toContain("Its worktree is archived first");
    expect(forgetQuestion("r", 3)).toContain("Its 3 worktrees are archived first");
  });
});
