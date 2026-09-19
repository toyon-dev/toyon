import { describe, expect, test } from "bun:test";
import { behindNote, canPull, originNote } from "./baseNote.ts";

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
    expect(originNote("main", { dirty: 0 })).toBeNull();
    expect(originNote("main", { behind: 0, dirty: 0 })).toBeNull();
    expect(originNote("main", { behind: 4, dirty: 0 })).toBe("4 behind origin");
  });
  test("says what held main where it is, and whether a pull could move it", () => {
    expect(originNote("main", { behind: 3, dirty: 2, stale: "dirty" })).toBe(
      "3 behind origin; ~2 uncommitted on main keep it where it is",
    );
    expect(originNote("main", { behind: 3, dirty: 1, stale: "dirty" })).toBe(
      "3 behind origin; ~1 uncommitted on main keeps it where it is",
    );
    // the files went since the daemon last looked: the plain count until it looks again
    expect(originNote("main", { behind: 3, dirty: 0, stale: "dirty" })).toBe("3 behind origin");
    expect(originNote("master", { behind: 1, dirty: 0, stale: "diverged" })).toBe("master has diverged from origin");
    expect(canPull({ stale: "diverged" })).toBe(false);
    expect(canPull({ stale: "dirty" })).toBe(true);
    expect(canPull({})).toBe(true);
  });
});
