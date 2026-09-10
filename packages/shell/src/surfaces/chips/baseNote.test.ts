import { describe, expect, test } from "bun:test";
import { baseNote, behindNote, originNote } from "./baseNote.ts";

describe("baseNote", () => {
  test("says nothing for a clean base, counted or not", () => {
    expect(baseNote("main", 0)).toBeNull();
    expect(baseNote("main", undefined)).toBeNull();
  });
  test("names the base and its count, singular and plural", () => {
    expect(baseNote("main", 1)).toBe("1 uncommitted on main stay behind");
    expect(baseNote("sticky header", 3)).toBe("3 uncommitted on sticky header stay behind");
  });
});

describe("behindNote", () => {
  test("nothing when level with the default branch", () => {
    expect(behindNote("main", 0)).toBeNull();
    expect(behindNote("main", undefined)).toBeNull();
  });
  test("counts the commits against the branch by name", () => {
    expect(behindNote("main", 1)).toBe("1 behind main");
    expect(behindNote("master", 12)).toBe("12 behind master");
  });
});

describe("originNote", () => {
  test("main against its upstream, or nothing", () => {
    expect(originNote(undefined)).toBeNull();
    expect(originNote(0)).toBeNull();
    expect(originNote(4)).toBe("4 behind origin");
  });
});
