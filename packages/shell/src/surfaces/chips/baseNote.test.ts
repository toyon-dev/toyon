import { describe, expect, test } from "bun:test";
import { behindNote, originNote } from "./baseNote.ts";

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
