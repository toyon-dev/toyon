import { describe, expect, test } from "bun:test";
import type { RouteInfo } from "@toyon/shared";
import {
  CHANGED_MAX,
  changedRoutes,
  completionFor,
  matches,
  normalizePath,
  paramRange,
  pathOf,
  rowsFor,
} from "./routePicker.ts";

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

  test("clearing the field lists everything again", () => {
    expect(rows("", ["/a", "/b"])).toEqual(["frequent /a", "frequent /b"]);
  });

  test("nothing visited, nothing changed and nothing typed is an empty list", () => {
    expect(rows("/about", [])).toEqual([]);
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

  test("a template in the field is its own row, not a go row", () => {
    expect(rows("/users/[id]", [], [route("/users/[id]")])).toEqual(["changed /users/[id]"]);
  });

  test("typing filters changed pages too", () => {
    expect(rows("pri", ["/pricing/team"], [route("/pricing"), route("/users/[id]")])).toEqual([
      "go /pri",
      "changed /pricing",
      "frequent /pricing/team",
    ]);
  });
});

describe("changed routes", () => {
  test("a route is changed when its file is uncommitted or committed ahead of main, and endpoints are not listed", () => {
    const routes = [
      route("/"),
      route("/pricing"),
      route("/about"),
      route("/api/x", { file: "app/api/x/route.ts", endpoint: true }),
    ];
    const git = {
      files: [{ path: "app/pricing/page.tsx" }, { path: "app/api/x/route.ts" }],
      committed: [{ path: "app/about/page.tsx" }],
    };
    expect(changedRoutes(routes, git).map((r) => r.path)).toEqual(["/pricing", "/about"]);
  });

  test("nothing is changed before the scan or the status arrives, and the list is capped", () => {
    expect(changedRoutes(undefined, { files: [] })).toEqual([]);
    expect(changedRoutes([route("/a")], undefined)).toEqual([]);
    const many = Array.from({ length: CHANGED_MAX + 4 }, (_, i) => route(`/p${i}`));
    expect(changedRoutes(many, { files: many.map((r) => ({ path: r.file })) })).toHaveLength(CHANGED_MAX);
  });
});

describe("route picker helpers", () => {
  test("a typed path gets a leading slash unless it is a query or a hash route", () => {
    expect(normalizePath(" about ")).toBe("/about");
    expect(normalizePath("/about")).toBe("/about");
    expect(normalizePath("?q=1")).toBe("?q=1");
    expect(normalizePath("#/tab")).toBe("#/tab");
  });

  test("matching ignores case and one leading slash", () => {
    expect(matches("/Pricing", "pri")).toBe(true);
    expect(matches("/pricing", "/PRI")).toBe(true);
    expect(matches("/docs", "pri")).toBe(false);
    expect(matches("/docs", " ")).toBe(true);
  });

  test("a completion keeps the form the query was typed in", () => {
    expect(completionFor("/pricing", "/pr")).toBe("/pricing");
    expect(completionFor("/pricing", "pr")).toBe("pricing");
    expect(completionFor("/pricing", "do")).toBeNull();
    expect(completionFor("/pricing", "")).toBeNull();
  });

  test("the whole parameter is selected, in each router's syntax", () => {
    const sel = (p: string) => {
      const r = paramRange(p);
      return r ? p.slice(r[0], r[1]) : null;
    };
    expect(sel("/users/[id]")).toBe("[id]");
    expect(sel("/blog/[...slug]")).toBe("[...slug]");
    expect(sel("/[[lang]]/docs")).toBe("[[lang]]");
    expect(sel("/concerts/:city")).toBe(":city");
    expect(sel("/:lang?/pricing")).toBe(":lang?");
    expect(sel("/posts/$postId/edit")).toBe("$postId");
    expect(sel("/files/*")).toBe("*");
    expect(sel("/pricing")).toBeNull();
  });

  test("the bar shows path, query and hash, and a missing page is the root", () => {
    expect(pathOf("http://x/a?b=1#/c")).toBe("/a?b=1#/c");
    expect(pathOf(undefined)).toBe("/");
    expect(pathOf("not a url")).toBe("/");
  });
});
