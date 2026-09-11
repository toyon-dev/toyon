import { describe, expect, test } from "bun:test";
import type { RouteInfo } from "@toyon/shared";
import { badgeCandidates, unseenOf } from "./seen.ts";

const page = (path: string, file: string, over: Partial<RouteInfo> = {}): RouteInfo => ({
  path,
  file,
  source: "next",
  dynamic: false,
  endpoint: false,
  ...over,
});

const routes = [
  page("/", "app/page.tsx"),
  page("/pricing", "app/pricing/page.tsx"),
  page("/api/x", "app/api/x/route.ts", { endpoint: true }),
  page("/a", "src/App.tsx", { source: "tanstack" }),
  page("/b", "src/App.tsx", { source: "tanstack" }),
];

describe("badge candidates", () => {
  test("a changed file holding one page, not on screen, is a candidate", () => {
    const changed = [
      { path: "app/pricing/page.tsx", xy: " M" },
      { path: "app/api/x/route.ts", xy: " M" },
      { path: "src/App.tsx", xy: " M" },
      { path: "README.md", xy: " M" },
      { path: "app/page.tsx", xy: "??" },
    ];
    // the endpoint, the file with two pages in it, a file with no page, and the page on screen are not
    expect(badgeCandidates(routes, changed, "app/page.tsx").map((f) => f.path)).toEqual(["app/pricing/page.tsx"]);
  });

  test("a file both uncommitted and committed ahead is one candidate, added if either says so", () => {
    const changed = [
      { path: "app/pricing/page.tsx", xy: " M" },
      { path: "app/pricing/page.tsx", xy: "A " },
    ];
    expect(badgeCandidates(routes, changed)).toEqual([{ path: "app/pricing/page.tsx", xy: "A " }]);
  });
});

describe("unseen pages", () => {
  const f = (path: string, xy = " M") => ({ path, xy });

  test("never opened: new when git says it was added, changed when it already existed", () => {
    const hashes = { "a.tsx": "1", "b.tsx": "2", "c.tsx": "3" };
    expect(unseenOf([f("a.tsx", "??"), f("b.tsx", "A "), f("c.tsx")], undefined, hashes)).toEqual({
      "a.tsx": "new",
      "b.tsx": "new",
      "c.tsx": "changed",
    });
  });

  test("opened before: nothing while it holds what you saw, changed once it does not", () => {
    const seen = { files: { "a.tsx": "1", "b.tsx": "2" } };
    expect(unseenOf([f("a.tsx", "??"), f("b.tsx")], seen, { "a.tsx": "1", "b.tsx": "9" })).toEqual({
      "b.tsx": "changed",
    });
  });

  test("a file gone by the time it was read carries nothing", () => {
    expect(unseenOf([f("a.tsx")], undefined, {})).toEqual({});
  });
});
