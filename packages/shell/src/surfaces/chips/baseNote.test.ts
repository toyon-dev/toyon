import { describe, expect, test } from "bun:test";
import { behindNote, canPull, hhmm, originNote } from "./baseNote.ts";

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
      "3 behind origin; an uncommitted file on main is in the pull's way",
    );
    // the files went since the daemon last looked: the plain count until it looks again
    expect(originNote("main", { behind: 3, dirty: 0, stale: "dirty" })).toBe("3 behind origin");
    expect(originNote("master", { behind: 1, dirty: 0, stale: "diverged" })).toBe("master has diverged from origin");
    expect(canPull({ stale: "diverged" })).toBe(false);
    expect(canPull({ stale: "dirty" })).toBe(true);
    expect(canPull({})).toBe(true);
  });
});

describe("originNote when origin cannot be reached", () => {
  test("a failed fetch stands ahead of any count, with when origin last answered", () => {
    const at = new Date(2026, 8, 24, 14, 2).getTime();
    expect(originNote("main", { behind: 0, dirty: 0, fetchFailed: "could not resolve host" })).toBe(
      "could not reach origin: could not resolve host",
    );
    expect(originNote("main", { behind: 3, dirty: 2, stale: "dirty", fetchedAt: at, fetchFailed: "timed out" })).toBe(
      "could not reach origin since 14:02: timed out",
    );
    expect(originNote("main", { behind: 3, dirty: 0, fetchedAt: at })).toBe("3 behind origin");
  });
  test("the clock reads hours and minutes, zero padded", () => {
    expect(hhmm(new Date(2026, 0, 1, 9, 5).getTime())).toBe("09:05");
  });
});
