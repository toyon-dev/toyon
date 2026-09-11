import { describe, expect, test } from "bun:test";
import { unseenJump } from "./unseenJump.ts";

/** 1 is a turn nobody has looked at, "w" an agent waiting on an answer */
const rows = (...flags: (0 | 1 | "w")[]) =>
  flags.map((f, i) => ({ id: `w${i}`, unseen: f === 1, agent: f === "w" ? "waiting" : "idle" }));

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
  test("from a draft, here is its seat under the first row", () => {
    const r = rows(1, 0, 1);
    expect(unseenJump(r, "w1", true, -1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w1", true, 1)).toEqual({ activate: "w2" });
  });
  test("a waiting agent outranks a nearer unseen turn, in either direction", () => {
    const r = rows(1, 0, 0, "w", 1);
    expect(unseenJump(r, "w1", false, 1)).toEqual({ activate: "w3" });
    // w0 is one step up and unseen, but the waiting row wins by wrapping round
    expect(unseenJump(r, "w1", false, -1)).toEqual({ activate: "w3" });
  });
  test("waiting rows wrap and take turns like unseen ones", () => {
    const r = rows("w", 0, "w", 0);
    expect(unseenJump(r, "w0", false, 1)).toEqual({ activate: "w2" });
    expect(unseenJump(r, "w2", false, 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w3", true, -1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w3", true, 1)).toEqual({ activate: "w2" });
  });
  test("once the only waiting row is on screen, unseen ones are next", () => {
    const r = rows(1, "w", 0);
    expect(unseenJump(r, "w1", false, 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w1", false, -1)).toEqual({ activate: "w0" });
  });
});
