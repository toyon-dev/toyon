import { describe, expect, test } from "bun:test";
import type { RouteInfo } from "@toyon/shared";
import { LINKS_MAX, mergeLinks, wantsLinks } from "./links.ts";

describe("links", () => {
  test("a page's links join what earlier pages showed, keyed as pages are, once each", () => {
    const had = [{ path: "/pricing", text: "Pricing" }];
    const merged = mergeLinks(had, [
      { path: "/pricing?ref=nav", text: "Plans" },
      { path: "/about/", text: "About us" },
      { path: "/__toyon/x", text: "no" },
    ]);
    expect(merged).toEqual([
      { path: "/pricing", text: "Pricing" },
      { path: "/about", text: "About us" },
    ]);
  });

  test("nothing new hands back the same array", () => {
    const had = [{ path: "/a", text: "A" }];
    expect(mergeLinks(had, [{ path: "/a", text: "Again" }])).toBe(had);
  });

  test("the list stops growing at its cap", () => {
    const many = Array.from({ length: LINKS_MAX + 20 }, (_, i) => ({ path: `/p${i}`, text: "" }));
    expect(mergeLinks([], many)).toHaveLength(LINKS_MAX);
  });

  test("links are asked for only once pages have arrived holding no page", () => {
    const page: RouteInfo = { path: "/", file: "app/page.tsx", source: "next", dynamic: false, endpoint: false };
    const endpoint: RouteInfo = { ...page, path: "/api", file: "app/api/route.ts", endpoint: true };
    expect(wantsLinks(undefined)).toBe(false);
    expect(wantsLinks({ routes: [], unseen: {} })).toBe(true);
    expect(wantsLinks({ routes: [endpoint], unseen: {} })).toBe(true);
    expect(wantsLinks({ routes: [page], unseen: {} })).toBe(false);
  });
});
