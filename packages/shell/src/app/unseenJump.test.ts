import { describe, expect, test } from "bun:test";
import { unseenJump } from "./unseenJump.ts";

const rows = (...flags: (0 | 1)[]) => flags.map((f, i) => ({ id: `w${i}`, unseen: f === 1 }));

describe("unseenJump", () => {
  test("nearest unseen in the direction pressed", () => {
    const r = rows(0, 1, 0, 1, 0);
    expect(unseenJump(r, "w0", false, 1)).toEqual({ activate: "w1" });
    expect(unseenJump(r, "w2", false, 1)).toEqual({ activate: "w3" });
    expect(unseenJump(r, "w4", false, -1)).toEqual({ activate: "w3" });
    expect(unseenJump(r, "w2", false, -1)).toEqual({ activate: "w1" });
  });
  test("wraps when the direction runs out", () => {
    const r = rows(0, 1, 0, 1, 0);
    expect(unseenJump(r, "w4", false, 1)).toEqual({ activate: "w1" });
    expect(unseenJump(r, "w0", false, -1)).toEqual({ activate: "w3" });
  });
  test("the row on screen never counts, even if flagged", () => {
    const r = rows(0, 1, 0);
    expect(unseenJump(r, "w1", false, 1)).toEqual({ draft: true });
    expect(unseenJump(r, "w1", false, -1)).toEqual({ activate: "w0" });
  });
  test("with none unseen, up is the first row and down is the draft", () => {
    const r = rows(0, 0, 0);
    expect(unseenJump(r, "w1", false, -1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w1", false, 1)).toEqual({ draft: true });
    // already drafting: down has nowhere to go
    expect(unseenJump(r, "w1", true, 1)).toBeNull();
    expect(unseenJump([], null, false, -1)).toBeNull();
  });
  test("from a draft, here is past the last row", () => {
    const r = rows(1, 0, 1);
    expect(unseenJump(r, "w1", true, -1)).toEqual({ activate: "w2" });
    expect(unseenJump(r, "w1", true, 1)).toEqual({ activate: "w0" });
  });
});
