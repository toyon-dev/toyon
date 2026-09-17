import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { parsePorcelain, statusFilesWithCounts } from "./status.ts";

describe("parsePorcelain", () => {
  test("plain modified / added / untracked", () => {
    expect(parsePorcelain(" M src/a.ts\nA  src/b.ts\n?? src/c.ts\n")).toEqual([
      { xy: " M", path: "src/a.ts" },
      { xy: "A ", path: "src/b.ts" },
      { xy: "??", path: "src/c.ts" },
    ]);
  });
  test("renames report the new path, not the old one", () => {
    expect(parsePorcelain("R  old.ts -> new.ts\n")).toEqual([{ xy: "R ", path: "new.ts" }]);
    expect(parsePorcelain("RM old/dir/a.ts -> new/dir/b.ts\n")).toEqual([{ xy: "RM", path: "new/dir/b.ts" }]);
  });
  test("a non-rename path containing ' -> ' is left alone", () => {
    expect(parsePorcelain(" M notes/a -> b.md\n")).toEqual([{ xy: " M", path: "notes/a -> b.md" }]);
  });
  test("quoted paths are unquoted (spaces, unicode escapes)", () => {
    expect(parsePorcelain('?? "with space.ts"\n')).toEqual([{ xy: "??", path: "with space.ts" }]);
    expect(parsePorcelain('R  "a b.ts" -> "c d.ts"\n')).toEqual([{ xy: "R ", path: "c d.ts" }]);
  });
  test("empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});

describe("statusFilesWithCounts", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);

  test("counts an untracked file's lines, and stops counting once there are too many", async () => {
    writeFileSync(join(repo, "one.txt"), "a\nb\nc\n");
    const few = await statusFilesWithCounts(repo);
    expect(few).toEqual([{ xy: "??", path: "one.txt", add: 3, del: 0 }]);
    // past the cap the count would mean reading every file, and the list is a tree to scroll
    // rather than a diff to read: a worktree with no .gitignore lists all of its node_modules
    for (let i = 0; i < 501; i++) writeFileSync(join(repo, `f${i}.txt`), "a\nb\nc\n");
    const many = await statusFilesWithCounts(repo);
    expect(many).toHaveLength(502);
    expect(many.every((f) => f.add === undefined && f.del === undefined)).toBe(true);
  });
});
