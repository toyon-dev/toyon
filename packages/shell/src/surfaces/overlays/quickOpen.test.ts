import { describe, expect, test } from "bun:test";
import { matchPositions, rankFiles, splitPath, withStatus } from "./quickOpen.ts";

const paths = [
  "src/pages/About.tsx",
  "src/pages/Home.tsx",
  ".gitignore",
  "index.html",
  "src/App.tsx",
  "src/main.tsx",
  "src/style.css",
  "vite.config.ts",
];
const status = [
  { path: "src/App.tsx", xy: " M", add: 38, del: 29 },
  { path: "src/style.css", xy: " M", add: 6 },
  { path: "src/pages/", xy: "??" },
];

describe("withStatus", () => {
  test("files under an untracked directory count as added without counts", () => {
    const row = withStatus(paths, status).find((r) => r.path === "src/pages/Home.tsx")!;
    expect(row.status).toEqual({ path: "src/pages/Home.tsx", xy: "??" });
  });
  test("deleted files come from status even though ls-files no longer lists them", () => {
    const rows = withStatus(["a.ts"], [{ path: "gone.ts", xy: " D", del: 12 }]);
    expect(rows.map((r) => r.path)).toEqual(["a.ts", "gone.ts"]);
  });
});

describe("rankFiles", () => {
  test("empty query: changed files first in panel order, then the rest alphabetically", () => {
    const { rows, changed } = rankFiles(paths, status, "");
    expect(rows.map((r) => r.path)).toEqual([
      "src/App.tsx",
      "src/style.css",
      "src/pages/About.tsx",
      "src/pages/Home.tsx",
      ".gitignore",
      "index.html",
      "src/main.tsx",
      "vite.config.ts",
    ]);
    expect(changed).toBe(4);
  });
  test("query: no divider, basename hits beat directory hits, changed files nudge ahead on ties", () => {
    const { rows, changed } = rankFiles(paths, status, "app");
    expect(changed).toBe(0);
    expect(rows[0]!.path).toBe("src/App.tsx");
  });
  test("query wins over changed status when the changed file barely matches", () => {
    const { rows } = rankFiles(paths, status, "vite");
    expect(rows[0]!.path).toBe("vite.config.ts");
  });
  test("limit caps both the rows and the divider index", () => {
    const { rows, changed } = rankFiles(paths, status, "", 2);
    expect(rows).toHaveLength(2);
    expect(changed).toBe(2);
  });
});

test("splitPath", () => {
  expect(splitPath("src/pages/About.tsx")).toEqual(["About.tsx", "src/pages/"]);
  expect(splitPath("index.html")).toEqual(["index.html", ""]);
});

test("matchPositions walks the same greedy path as the scorer", () => {
  expect(matchPositions("src/App.tsx", "app")).toEqual([4, 5, 6]);
  expect(matchPositions("src/App.tsx", "zz")).toBeNull();
});
