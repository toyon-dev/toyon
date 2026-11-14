import { describe, expect, test } from "bun:test";
import type { PathEntry, PathTarget } from "@toyon/shared";
import {
  commandAsPath,
  diskPath,
  escapeName,
  pathKindsWith,
  pathRows,
  pathWritten,
  unescapePath,
} from "./pathComplete.ts";

const dir = (name: string, isRepo = false): PathEntry => ({ path: `~/${name}`, name, isRepo, isFile: false });
const file = (name: string): PathEntry => ({ path: `~/${name}`, name, isRepo: false, isFile: true });
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("pathRows", () => {
  const home = { query: "~/", entries: [dir("Projects"), dir("Pictures"), dir("Music"), file("notes.md")] };

  test("a folder completes to itself with its slash, a file to its name", () => {
    expect(pathRows("~/", home, false)).toEqual([
      { name: "Projects", completion: "~/Projects/", folder: true },
      { name: "Pictures", completion: "~/Pictures/", folder: true },
      { name: "Music", completion: "~/Music/", folder: true },
      { name: "notes.md", completion: "~/notes.md", folder: false },
    ]);
  });

  test("an answer about the same folder is narrowed to the name as it stands", () => {
    expect(names(pathRows("~/P", home, false))).toEqual(["Projects", "Pictures"]);
    expect(names(pathRows("~/pro", home, false))).toEqual(["Projects"]);
    // a letter taken back: the narrower answer still holds what it held
    const narrowed = { query: "~/Pro", entries: [dir("Projects")] };
    expect(names(pathRows("~/Pr", narrowed, false))).toEqual(["Projects"]);
  });

  test("an answer about another folder, or another name in this one, says nothing", () => {
    expect(pathRows("~/Projects/", home, false)).toEqual([]);
    expect(pathRows("/etc/ho", home, false)).toEqual([]);
    expect(pathRows("~/Mu", { query: "~/Pro", entries: [dir("Projects")] }, false)).toEqual([]);
    expect(pathRows("~/", null, false)).toEqual([]);
  });

  test("the completion is spelt as the disk spells it, whatever case was typed", () => {
    expect(pathRows("~/proj", home, false)[0]?.completion).toBe("~/Projects/");
  });

  test("a path already written out offers nothing; a folder short of its slash offers the slash", () => {
    expect(pathRows("~/notes.md", home, false)).toEqual([]);
    expect(pathRows("~/Music", home, false)).toEqual([{ name: "Music", completion: "~/Music/", folder: true }]);
  });

  test("a name with a space is written with a backslash, and read back through one", () => {
    const lib = { query: "~/Library/", entries: [dir("Application Support"), dir("Caches")] };
    expect(pathRows("~/Library/App", lib, false)[0]?.completion).toBe("~/Library/Application\\ Support/");
    const inside = { query: "~/Library/Application Support/", entries: [dir("Code")] };
    expect(pathRows("~/Library/Application\\ Support/", inside, false)).toEqual([
      { name: "Code", completion: "~/Library/Application\\ Support/Code/", folder: true },
    ]);
  });

  test("a command escapes what its shell would read; a message only the space", () => {
    const answer = { query: "~/", entries: [file("draft (1).txt")] };
    expect(pathRows("~/d", answer, false)[0]?.completion).toBe("~/draft\\ (1).txt");
    expect(pathRows("~/d", answer, true)[0]?.completion).toBe("~/draft\\ \\(1\\).txt");
  });
});

describe("pathRows: from the worktree", () => {
  const base = "/w/app/";
  const root = { query: "/w/app/", entries: [dir("packages"), dir("scripts"), file("package.json")] };

  test("a word that names no root is read from the base, and completed as it was typed", () => {
    expect(
      pathRows("pa", { query: "/w/app/pa", entries: root.entries.filter((e) => e.name.startsWith("pa")) }, true, base),
    ).toEqual([
      { name: "packages", completion: "packages/", folder: true },
      { name: "package.json", completion: "package.json", folder: false },
    ]);
    const inner = { query: "/w/app/./packages/", entries: [dir("shell")] };
    expect(pathRows("./packages/sh", inner, true, base)[0]?.completion).toBe("./packages/shell/");
  });

  test("an answer about the same word read from the disk's root is not this one", () => {
    expect(pathRows("pa", { query: "/pa", entries: [dir("patches")] }, true, base)).toEqual([]);
    expect(pathRows("pa", root, true)).toEqual([]);
  });
});

describe("pathWritten", () => {
  const home = { query: "~/", entries: [dir("Projects"), dir("Music"), file("notes.md"), file("notes.md.bak")] };

  test("a name still half typed is not written, whatever it would complete to", () => {
    expect(pathWritten("~/Pro", home)).toBe(false);
    expect(pathWritten("~/note", home)).toBe(false);
    // the disk's spelling is the one that counts: the row is there to mend the case
    expect(pathWritten("~/music", home)).toBe(false);
  });

  test("a word that ends in a folder's slash asks what is in it, and is not written", () => {
    expect(pathWritten("~/", home)).toBe(false);
    expect(pathWritten("~/Projects/", { query: "~/Projects/", entries: [dir("toyon")] })).toBe(false);
    expect(pathWritten("~/Projects/", null)).toBe(false);
  });

  test("a name the answer lists as typed is written, though longer names start with it", () => {
    expect(pathWritten("~/notes.md", home)).toBe(true);
    expect(pathWritten("~/Music", home)).toBe(true);
  });

  test("a held space is read before the name is compared", () => {
    expect(pathWritten("~/My\\ Notes", { query: "~/", entries: [dir("My Notes")] })).toBe(true);
  });

  test("an answer about another folder, or none, says nothing of the name", () => {
    expect(pathWritten("~/Projects/notes.md", home)).toBe(false);
    expect(pathWritten("~/notes.md", null)).toBe(false);
  });

  test("a word that names no root is read from the base", () => {
    const root = { query: "/w/app/pa", entries: [dir("packages"), file("package.json")] };
    expect(pathWritten("pa", root, "/w/app/")).toBe(false);
    expect(pathWritten("package.json", root, "/w/app/")).toBe(true);
    expect(pathWritten("package.json", root)).toBe(false);
  });
});

describe("diskPath and pathKindsWith", () => {
  const home = "/Users/k";
  const target = (over: Partial<PathTarget>): PathTarget => ({
    exists: true,
    isDir: false,
    isRepo: false,
    isFile: false,
    parentExists: true,
    ...over,
  });

  test("one spelling per place: home written out, no slash at the end", () => {
    expect(diskPath("~/Projects/", home)).toBe("/Users/k/Projects");
    expect(diskPath("~", home)).toBe("/Users/k");
    expect(diskPath("/etc/hosts", home)).toBe("/etc/hosts");
    expect(diskPath("/", home)).toBe("/");
    expect(diskPath("src/App.tsx", home)).toBeNull();
    expect(diskPath("~/x", "")).toBeNull();
  });

  test("an answer says what the path asked about is, and what every entry beside it is", () => {
    const kinds = pathKindsWith(
      { "/old": "file" },
      { query: "~/Pro", entries: [dir("Projects"), file("Procfile")], target: target({ exists: false }) },
      home,
    );
    expect(kinds).toEqual({
      "/old": "file",
      "/Users/k/Pro": "none",
      "/Users/k/Projects": "folder",
      "/Users/k/Procfile": "file",
    });
    expect(pathKindsWith({}, { query: "~/Projects/", entries: [], target: target({ isDir: true }) }, home)).toEqual({
      "/Users/k/Projects": "folder",
    });
    expect(pathKindsWith({}, { query: "/etc/hosts", entries: [], target: target({ isFile: true }) }, home)).toEqual({
      "/etc/hosts": "file",
    });
  });

  test("a path found later overwrites the answer that it was not there", () => {
    const first = pathKindsWith({}, { query: "~/new.md", entries: [], target: target({ exists: false }) }, home);
    const then = pathKindsWith(
      first,
      { query: "~/", entries: [file("new.md")], target: target({ isDir: true }) },
      home,
    );
    expect(then["/Users/k/new.md"]).toBe("file");
  });
});

describe("escapeName and unescapePath", () => {
  test("round-trip", () => {
    for (const shell of [false, true]) {
      for (const name of ["plain", "two words", "it's (1) & more", "back\\slash"]) {
        expect(unescapePath(escapeName(name, shell))).toBe(name);
      }
    }
  });
});

describe("commandAsPath", () => {
  test("a command's word read as the path it also spells", () => {
    expect(commandAsPath({ kind: "command", query: "Us", from: 0, to: 3 })).toEqual({
      kind: "path",
      query: "/Us",
      from: 0,
      to: 3,
    });
  });

  test("a bare slash and any other trigger are not one", () => {
    expect(commandAsPath({ kind: "command", query: "", from: 0, to: 1 })).toBeNull();
    expect(commandAsPath({ kind: "file", query: "src", from: 0, to: 4 })).toBeNull();
    expect(commandAsPath(null)).toBeNull();
  });
});
