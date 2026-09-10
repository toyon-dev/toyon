import { describe, expect, test } from "bun:test";
import { parseForEachRef } from "./refs.ts";

const rec = (fields: string[]) => `${fields.join("\0")}\x1e`;

describe("parseForEachRef", () => {
  test("a local branch with a worktree and an upstream, one without, and a remote one", () => {
    const out = [
      rec(["refs/heads/main", "81ac533", "/Users/k/Projects/toyon", "origin/main", "1700000000", "init"]),
      rec(["refs/heads/feature", "22fe40c", "", "", "1700000100", "add the thing"]),
      rec(["refs/remotes/origin/feature", "22fe40c", "", "", "1700000100", "add the thing"]),
      rec(["refs/remotes/origin/HEAD", "81ac533", "", "", "1700000000", "init"]),
    ].join("\n");
    expect(parseForEachRef(out)).toEqual([
      {
        name: "main",
        sha: "81ac533",
        worktreePath: "/Users/k/Projects/toyon",
        upstream: "origin/main",
        at: 1700000000000,
        subject: "init",
      },
      { name: "feature", sha: "22fe40c", at: 1700000100000, subject: "add the thing" },
      { name: "feature", remote: "origin", sha: "22fe40c", at: 1700000100000, subject: "add the thing" },
    ]);
  });

  test("a subject may hold a tab or a slash; a branch name may hold slashes", () => {
    const out = rec(["refs/heads/feat/nested/name", "abc1234", "", "", "1", "fix\tthe a/b thing"]);
    expect(parseForEachRef(out)[0]).toMatchObject({ name: "feat/nested/name", subject: "fix\tthe a/b thing" });
  });

  test("empty output, a missing trailing separator, and refs of another kind", () => {
    expect(parseForEachRef("")).toEqual([]);
    expect(parseForEachRef("refs/heads/x\0abc\0\0\x01\0s")).toHaveLength(1);
    expect(parseForEachRef(rec(["refs/tags/v1", "abc", "", "", "1", "tag"]))).toEqual([]);
  });
});
