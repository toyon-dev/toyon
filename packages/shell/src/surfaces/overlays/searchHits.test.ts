import { describe, expect, test } from "bun:test";
import { searchHits } from "./SearchPalette.tsx";

describe("searchHits", () => {
  test("marks every occurrence of the query, as the daemon matched it", () => {
    expect(searchHits("foo bar foo", "foo")).toEqual([0, 1, 2, 8, 9, 10]);
  });

  test("ignores case, as the daemon does", () => {
    expect(searchHits("Search and Ask", "search and")).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  test("trims the query, which the daemon trimmed before matching", () => {
    expect(searchHits("a foo b", " foo ")).toEqual([2, 3, 4]);
  });

  test("marks nothing on a line the query is not in, or for an empty query", () => {
    expect(searchHits("nothing here", "foo")).toBeNull();
    expect(searchHits("nothing here", "  ")).toBeNull();
  });

  test("marks nothing when lowercasing moved the columns", () => {
    expect(searchHits("İstanbul", "stanbul")).toBeNull();
  });
});
