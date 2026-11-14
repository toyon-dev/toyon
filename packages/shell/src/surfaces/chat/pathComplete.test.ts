import { describe, expect, test } from "bun:test";
import type { PathEntry } from "@toyon/shared";
import { commandAsPath, escapeName, pathRows, unescapePath } from "./pathComplete.ts";

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
