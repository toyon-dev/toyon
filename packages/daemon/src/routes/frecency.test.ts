import { describe, expect, test } from "bun:test";
import { bump, HALF_LIFE_MS, KEEP, rank, type Visit } from "./frecency.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function visits(...seq: Array<[string, number]>): Record<string, Visit> {
  const pages: Record<string, Visit> = {};
  for (const [key, at] of seq) bump(pages, key, at);
  return pages;
}

describe("frecency", () => {
  test("a page visited three times outranks one visited once since", () => {
    const pages = visits(["/a", 0], ["/a", 1], ["/a", 2], ["/b", 12 * HOUR]);
    expect(rank(pages, 12 * HOUR)).toEqual(["/a", "/b"]);
  });

  test("a favourite from a week ago falls below this morning's two visits", () => {
    const pages = visits(
      ...Array.from({ length: 5 }, (_, i): [string, number] => ["/old", i]),
      ["/new", 7 * DAY],
      ["/new", 7 * DAY + HOUR],
    );
    expect(rank(pages, 7 * DAY + 2 * HOUR)).toEqual(["/new", "/old"]);
  });

  test("a visit adds to what is left of the score, not to the raw count", () => {
    const pages = visits(["/a", 0]);
    bump(pages, "/a", HALF_LIFE_MS);
    expect(pages["/a"]).toEqual({ score: 1.5, last: HALF_LIFE_MS });
  });

  test("a tie goes to the page visited last", () => {
    // two visits that have halved once stand exactly level with one visit made now
    const pages: Record<string, Visit> = { "/old": { score: 2, last: 0 }, "/new": { score: 1, last: HALF_LIFE_MS } };
    expect(rank(pages, HALF_LIFE_MS)).toEqual(["/new", "/old"]);
  });

  test("past the cap the weakest page goes, never the one just visited", () => {
    const pages: Record<string, Visit> = {};
    for (let i = 0; i < KEEP; i++) pages[`/p${i}`] = { score: 2, last: 0 };
    pages["/p7"] = { score: 1, last: 0 };
    bump(pages, "/fresh", 0);
    expect(Object.keys(pages).length).toBe(KEEP);
    expect(pages["/p7"]).toBeUndefined();
    expect(pages["/fresh"]).toBeDefined();
  });

  test("rank returns at most n", () => {
    const pages = visits(["/a", 0], ["/b", 1], ["/c", 2]);
    expect(rank(pages, 3, 2)).toEqual(["/c", "/b"]);
  });
});
