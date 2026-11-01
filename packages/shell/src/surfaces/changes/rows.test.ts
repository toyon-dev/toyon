import { describe, expect, test } from "bun:test";
import type { GitInfo } from "@toyon/shared";
import { changeSections } from "./rows.ts";

const git: GitInfo = {
  version: 1,
  files: [
    { path: "src/a.test.ts", xy: " M" },
    { path: "src/a.ts", xy: " M" },
    { path: "src/b.ts", xy: "??" },
  ],
  extras: {
    committed: [
      { path: "src/b.ts", xy: "A " },
      { path: "README.md", xy: "M " },
    ],
    turn: { base: "t0", files: [{ path: "src/a.ts", xy: " M" }] },
  },
};

describe("changeSections", () => {
  test("each section reads its changes first and its tests after", () => {
    const c = changeSections(git, { turn: true, committed: true });
    expect(c.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/a.test.ts"]);
    expect(c.fileSource).toBe(2);
    expect(c.turned.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(c.turnBase).toBe("t0");
    expect(c.committed.map((f) => f.path)).toEqual(["src/b.ts", "README.md"]);
  });

  test("a shut section leaves the list, and the turn keeps its base for the menu", () => {
    const c = changeSections(git, { turn: false, committed: false });
    expect(c.turned).toEqual([]);
    expect(c.committed).toEqual([]);
    expect(c.turnBase).toBe("t0");
  });

  test("no git state yet is three empty sections", () => {
    const c = changeSections(null, { turn: true, committed: true });
    expect([c.files.length, c.turned.length, c.committed.length]).toEqual([0, 0, 0]);
  });
});
