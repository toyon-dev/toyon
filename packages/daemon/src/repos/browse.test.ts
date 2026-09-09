import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browsePath } from "./browse.ts";

// The project picker's completion: a prefix narrows, a trailing slash lists, repos sort ahead of
// plain folders, and nothing here may throw on a path that is not there.

function tree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "toyon-browse-"));
  for (const d of ["cookbook", "cookbook-old", "cabinet", ".hidden", "notes"]) mkdirSync(join(root, d));
  // a checkout has .git as a directory; a linked worktree has it as a file. Both are openable.
  mkdirSync(join(root, "cookbook", ".git"));
  writeFileSync(join(root, "cookbook-old", ".git"), "gitdir: /elsewhere\n");
  writeFileSync(join(root, "loose.txt"), "x");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("browsePath", () => {
  test("a prefix narrows to matching directories and skips files", async () => {
    const { root, cleanup } = tree();
    const names = (await browsePath(join(root, "cook"))).entries.map((e) => e.name);
    expect(names).toEqual(["cookbook", "cookbook-old"]);
    cleanup();
  });

  test("a trailing slash lists the directory, repos first, and hides dotfiles", async () => {
    const { root, cleanup } = tree();
    const { entries } = await browsePath(`${root}/`);
    expect(entries.map((e) => e.name)).toEqual(["cookbook", "cookbook-old", "cabinet", "notes"]);
    // .git as a file counts too, so a linked worktree is openable
    expect(entries.filter((e) => e.isRepo).map((e) => e.name)).toEqual(["cookbook", "cookbook-old"]);
    cleanup();
  });

  test("a dot prefix opts back into hidden directories", async () => {
    const { root, cleanup } = tree();
    expect((await browsePath(join(root, ".hid"))).entries.map((e) => e.name)).toEqual([".hidden"]);
    cleanup();
  });

  test("a path that is not there is empty, not an error", async () => {
    expect((await browsePath("/definitely/not/here/at/all")).entries).toEqual([]);
    expect((await browsePath("")).entries).toEqual([]);
    // relative input has no meaning without a cwd to resolve against, so it offers nothing
    expect((await browsePath("cookbook")).entries).toEqual([]);
  });

  test("matching ignores case, the way the picker is typed", async () => {
    const { root, cleanup } = tree();
    expect((await browsePath(join(root, "COOKB"))).entries.map((e) => e.name)).toEqual(["cookbook", "cookbook-old"]);
    cleanup();
  });

  // the entries answer "what is in here"; the target answers "is there a here". Without it an empty
  // entry list means "nothing matches yet" and "no such folder" alike, and only one of those is
  // somewhere a project may be made.
  test("the target separates a typo from a folder with nothing matching yet", async () => {
    const { root, cleanup } = tree();
    const missingLeaf = await browsePath(join(root, "brand-new"));
    expect(missingLeaf.entries).toEqual([]);
    expect(missingLeaf.target).toEqual({ exists: false, isDir: false, isRepo: false, parentExists: true });

    const missingParent = await browsePath(join(root, "typo", "brand-new"));
    expect(missingParent.target.parentExists).toBe(false);
    cleanup();
  });

  test("the target says whether the typed folder is already a repo", async () => {
    const { root, cleanup } = tree();
    expect((await browsePath(join(root, "cookbook"))).target).toEqual({
      exists: true,
      isDir: true,
      isRepo: true,
      parentExists: true,
    });
    expect((await browsePath(join(root, "notes"))).target).toEqual({
      exists: true,
      isDir: true,
      isRepo: false,
      parentExists: true,
    });
    // a trailing slash names the folder itself, so the target describes that, not its parent
    expect((await browsePath(`${join(root, "notes")}/`)).target.isDir).toBe(true);
    cleanup();
  });
});
