import { describe, expect, test } from "bun:test";
import { diskKey, indexKey, listedFiles, listingDelta, onDisk } from "./listing.ts";

describe("onDisk", () => {
  test("a file is gone when the worktree's column says so, or a deletion is staged", () => {
    for (const xy of [" D", "MD", "AD", "RD", "D "]) expect(onDisk(xy)).toBe(false);
  });

  test("anything else is a file on disk, untracked included", () => {
    for (const xy of ["??", " M", "M ", "MM", "A ", "AM", "R ", "RM", "C "]) expect(onDisk(xy)).toBe(true);
  });

  test("an unmerged path is one the status does not answer for", () => {
    for (const xy of ["UU", "AA", "AU", "UA", "DU", "UD", "DD"]) expect(onDisk(xy)).toBeNull();
  });
});

describe("indexKey", () => {
  const head = "abc123";

  test("an edit, a new file and a deleted one leave the index's paths alone", () => {
    const clean = indexKey(head, []);
    expect(indexKey(head, [{ path: "a.ts", xy: " M" }])).toBe(clean);
    expect(indexKey(head, [{ path: "a.ts", xy: "M " }])).toBe(clean);
    expect(indexKey(head, [{ path: "new.ts", xy: "??" }])).toBe(clean);
    expect(indexKey(head, [{ path: "old.ts", xy: " D" }])).toBe(clean);
  });

  test("a path staged in or out of the index moves it, and so does a merge left unresolved", () => {
    const clean = indexKey(head, []);
    for (const xy of ["A ", "D ", "R ", "C ", "UU", "DD"]) {
      expect(indexKey(head, [{ path: "x.ts", xy }])).not.toBe(clean);
    }
    // what happens to a staged path on disk afterwards changes nothing in the index
    expect(indexKey(head, [{ path: "x.ts", xy: "AM" }])).toBe(indexKey(head, [{ path: "x.ts", xy: "A " }]));
  });

  test("a new commit moves it even when the status is clean", () => {
    expect(indexKey("def456", [])).not.toBe(indexKey(head, []));
  });
});

describe("diskKey", () => {
  test("moves when a file comes or goes, and not when one that exists is edited", () => {
    const clean = diskKey([]);
    expect(diskKey([{ path: "a.ts", xy: " M" }])).toBe(clean);
    expect(diskKey([{ path: "new.ts", xy: "??" }])).not.toBe(clean);
    expect(diskKey([{ path: "old.ts", xy: " D" }])).not.toBe(clean);
  });
});

describe("the files on disk", () => {
  const tracked = ["README.md", "docs/c.md", "src/a.ts", "src/b.ts"];
  const files = (status: Array<{ path: string; xy: string }>) => listedFiles(tracked, listingDelta(tracked, status));

  test("with nothing new or gone the index's own list is handed back", () => {
    expect(files([])).toBe(tracked);
    expect(files([{ path: "src/a.ts", xy: " M" }])).toBe(tracked);
  });

  test("a file deleted from disk leaves the list while the index still has it", () => {
    expect(files([{ path: "src/a.ts", xy: " D" }])).toEqual(["README.md", "docs/c.md", "src/b.ts"]);
  });

  test("an untracked file joins it", () => {
    expect(files([{ path: "src/new.ts", xy: "??" }])).toEqual([...tracked, "src/new.ts"]);
  });

  test("a rename done on disk lists the new name and not the old one", () => {
    const moved = files([
      { path: "docs/c.md", xy: " D" },
      { path: "docs/renamed.md", xy: "??" },
    ]);
    expect(moved).toEqual(["README.md", "src/a.ts", "src/b.ts", "docs/renamed.md"]);
  });

  test("a file the index dropped and the disk kept, which arrives as modified, is listed", () => {
    expect(files([{ path: "kept.ts", xy: " M" }])).toEqual([...tracked, "kept.ts"]);
  });

  test("an unmerged path stays as the index's list has it, in or out", () => {
    expect(files([{ path: "src/a.ts", xy: "UD" }])).toBe(tracked);
    expect(files([{ path: "left.ts", xy: "DU" }])).toBe(tracked);
  });

  test("a path the index already holds is not listed twice", () => {
    expect(files([{ path: "src/a.ts", xy: "A " }])).toBe(tracked);
  });

  test("the same difference reads as the same key, whatever else the status says", () => {
    const one = listingDelta(tracked, [{ path: "n.ts", xy: "??" }]);
    const two = listingDelta(tracked, [
      { path: "src/b.ts", xy: " M" },
      { path: "n.ts", xy: "??" },
    ]);
    expect(two.key).toBe(one.key);
    expect(listingDelta(tracked, []).key).not.toBe(one.key);
  });
});
