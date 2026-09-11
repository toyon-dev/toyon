import { describe, expect, test } from "bun:test";
import { completionFor, matches, normalizePath, pathOf, rowsFor } from "./routePicker.ts";

const rows = (query: string, frequent: string[], current = "/about", here: string | null = "/about") =>
  rowsFor({ query, current, here, frequent }).map((r) => `${r.kind} ${r.path}`);

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
    expect(rows("/about ", ["/about", "/about/team"], "/about?x=1", "/about")).toEqual([
      "go /about",
      "frequent /about/team",
    ]);
  });

  test("clearing the field lists everything again", () => {
    expect(rows("", ["/a", "/b"])).toEqual(["frequent /a", "frequent /b"]);
  });

  test("nothing visited yet and nothing typed is an empty list", () => {
    expect(rows("/about", [])).toEqual([]);
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

  test("the bar shows path, query and hash, and a missing page is the root", () => {
    expect(pathOf("http://x/a?b=1#/c")).toBe("/a?b=1#/c");
    expect(pathOf(undefined)).toBe("/");
    expect(pathOf("not a url")).toBe("/");
  });
});
