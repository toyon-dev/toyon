import { describe, expect, test } from "bun:test";
import { encodeKnown, parseKnown, sameStamp } from "./stamps.ts";

describe("known", () => {
  const stamps = { rows: "a1", repos: "b2", visits: "c3", themes: "d4" };
  test("the four parts on dots, and back", () => {
    expect(encodeKnown(stamps)).toBe("a1.b2.c3.d4");
    expect(parseKnown("a1.b2.c3.d4")).toEqual(stamps);
  });
  test("a part the page cannot vouch for is empty, and never matches", () => {
    expect(encodeKnown({ ...stamps, rows: "" })).toBe(".b2.c3.d4");
    expect(encodeKnown({ themes: "d4" })).toBe("...d4");
    expect(parseKnown(".b2.c3.d4")).toEqual({ ...stamps, rows: "" });
    expect(sameStamp("", "")).toBe(false);
    expect(sameStamp("a1", "a1")).toBe(true);
    expect(sameStamp("a1", "a2")).toBe(false);
  });
  test("nothing, or not four hex parts, is no known at all", () => {
    expect(parseKnown(null)).toBeNull();
    expect(parseKnown("")).toBeNull();
    expect(parseKnown("a1.b2.c3")).toBeNull();
    expect(parseKnown("a1.b2.c3.d4.e5")).toBeNull();
    expect(parseKnown("a1.b2.c3.zz")).toBeNull();
    expect(parseKnown(`${"f".repeat(33)}.b2.c3.d4`)).toBeNull();
  });
});
