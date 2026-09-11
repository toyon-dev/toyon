import { describe, expect, test } from "bun:test";
import type { RouteInfo } from "@toyon/shared";
import { CHANGED_MAX, changedRoutes, completionFor, matches, normalizePath, pathOf, rowsFor } from "./routePicker.ts";

const route = (path: string, over: Partial<RouteInfo> = {}): RouteInfo => ({
  path,
  file: `app${path === "/" ? "" : path}/page.tsx`,
  source: "next",
  dynamic: /[[:$*]/.test(path),
  endpoint: false,
  ...over,
});

const rows = (
  query: string,
  frequent: string[],
  changed: RouteInfo[] = [],
  current = "/about",
  here: string | null = "/about",
) => rowsFor({ query, current, here, frequent, changed }).map((r) => `${r.kind} ${r.path}`);

describe("route picker rows", () => {
  test("opening on the page's own address lists every other page, with no go row", () => {
    expect(rows("/about", ["/pricing", "/about", "/docs"])).toEqual(["frequent /pricing", "frequent /docs"]);
  });

  test("typing filters the pages and leads with the typed path", () => {
    expect(rows("/pri", ["/pricing", "/docs", "/pricing/team"])).toEqual([
      "go /pri",
      "frequent /pricing",
      "frequent /pricing/team",
    ]);
  });

  test("a typed path that is already a row is not offered twice", () => {
    expect(rows("docs", ["/pricing", "/docs"])).toEqual(["frequent /docs"]);
  });

  test("the page on screen is left out even when typed, so enter on it reloads through the go row", () => {
    expect(rows("/about ", ["/about", "/about/team"], [], "/about?x=1", "/about")).toEqual([
      "go /about",
      "frequent /about/team",
    ]);
  });

  test("changed pages lead, and a page both changed and visited is listed once, as changed", () => {
    expect(rows("/about", ["/pricing", "/docs"], [route("/pricing"), route("/users/[id]")])).toEqual([
      "changed /pricing",
      "changed /users/[id]",
      "frequent /docs",
    ]);
  });

  test("a changed page on screen is left out, and a changed template never is", () => {
    expect(rows("/about", [], [route("/about"), route("/users/[id]")])).toEqual(["changed /users/[id]"]);
  });
});

describe("changed routes", () => {
  test("a route is changed when its file carries a badge, and an endpoint never is", () => {
    const routes = [
      route("/"),
      route("/pricing"),
      route("/about"),
      route("/api/x", { file: "app/api/x/route.ts", endpoint: true }),
    ];
    const unseen = {
      "app/pricing/page.tsx": "changed",
      "app/about/page.tsx": "new",
      "app/api/x/route.ts": "new",
    } as const;
    expect(changedRoutes(routes, unseen).map((r) => r.path)).toEqual(["/pricing", "/about"]);
  });

  test("nothing is changed before the pages arrive, and the list is capped", () => {
    expect(changedRoutes(undefined, {})).toEqual([]);
    expect(changedRoutes([route("/a")], undefined)).toEqual([]);
    const many = Array.from({ length: CHANGED_MAX + 4 }, (_, i) => route(`/p${i}`));
    const unseen = Object.fromEntries(many.map((r) => [r.file, "new" as const]));
    expect(changedRoutes(many, unseen)).toHaveLength(CHANGED_MAX);
  });
});

describe("route picker helpers", () => {
  test("a typed path gets a leading slash unless it is a query or a hash route", () => {
    expect(normalizePath(" about ")).toBe("/about");
    expect(normalizePath("?q=1")).toBe("?q=1");
    expect(normalizePath("#/tab")).toBe("#/tab");
  });

  test("matching ignores case and one leading slash", () => {
    expect(matches("/Pricing", "pri")).toBe(true);
    expect(matches("/docs", "pri")).toBe(false);
  });

  test("a completion keeps the form the query was typed in", () => {
    expect(completionFor("/pricing", "/pr")).toBe("/pricing");
    expect(completionFor("/pricing", "pr")).toBe("pricing");
    expect(completionFor("/pricing", "")).toBeNull();
  });

  test("the bar shows path, query and hash, and a missing page is the root", () => {
    expect(pathOf("http://x/a?b=1#/c")).toBe("/a?b=1#/c");
    expect(pathOf(undefined)).toBe("/");
  });
});
