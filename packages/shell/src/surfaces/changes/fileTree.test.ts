import { describe, expect, test } from "bun:test";
import { buildTree, marks, visibleRows } from "./fileTree.ts";

describe("buildTree", () => {
  test("folders come before files, each in natural order", () => {
    const top = buildTree(["b.ts", "file10.ts", "file2.ts", "src/a.ts", "Assets/x.png"]);
    expect(top.map((n) => n.name)).toEqual(["Assets", "src", "b.ts", "file2.ts", "file10.ts"]);
  });

  test("a submodule sorts with the folders and holds nothing", () => {
    const top = buildTree(["README.md"], ["vendor"]);
    expect(top.map((n) => [n.name, n.kind, n.children.length])).toEqual([
      ["vendor", "submodule", 0],
      ["README.md", "file", 0],
    ]);
  });

  test("an ignored file is a file and a folder ignored whole is one row that holds nothing", () => {
    const top = buildTree(["README.md"], [], [".env", "node_modules/"]);
    expect(top.map((n) => [n.name, n.kind, n.ignored, n.children.length])).toEqual([
      ["node_modules", "ignored", true, 0],
      [".env", "file", true, 0],
      ["README.md", "file", false, 0],
    ]);
  });

  test("a folder with an ignored file beside a real one is not ignored, though the file is", () => {
    const [src] = buildTree(["src/main.ts"], [], ["src/.env"]);
    expect([src?.name, src?.ignored]).toEqual(["src", false]);
    expect(src?.children.map((n) => [n.name, n.ignored])).toEqual([
      [".env", true],
      ["main.ts", false],
    ]);
  });
});

describe("visibleRows", () => {
  const tree = buildTree(["src/app/keys.ts", "src/main.ts", "README.md"]);

  test("a closed folder hides what is in it", () => {
    expect(visibleRows(tree, () => false).map((r) => r.path)).toEqual(["src", "README.md"]);
  });

  test("each open folder shows its children a level deeper", () => {
    const rows = visibleRows(tree, (p) => p === "src" || p === "src/app");
    expect(rows.map((r) => [r.path, r.depth, r.open])).toEqual([
      ["src", 0, true],
      ["src/app", 1, true],
      ["src/app/keys.ts", 2, false],
      ["src/main.ts", 1, false],
      ["README.md", 0, false],
    ]);
  });

  test("an open folder inside a closed one stays hidden", () => {
    const rows = visibleRows(tree, (p) => p === "src/app");
    expect(rows.map((r) => r.path)).toEqual(["src", "README.md"]);
  });
});

describe("marks", () => {
  test("a changed file marks itself and every folder holding it", () => {
    const m = marks([{ path: "src/app/keys.ts", xy: " M" }]);
    expect(m.files.get("src/app/keys.ts")?.xy).toBe(" M");
    expect([...m.folders]).toEqual(["src", "src/app"]);
  });

  test("an untracked folder listed whole marks the folder, not a file", () => {
    const m = marks([{ path: "src/new/", xy: "??" }]);
    expect(m.files.size).toBe(0);
    expect([...m.folders].sort()).toEqual(["src", "src/new"]);
  });
});
