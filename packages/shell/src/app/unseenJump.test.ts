import { describe, expect, test } from "bun:test";
import { needsYou, needsYouAcross, owedJumpAcross, unseenJump } from "./unseenJump.ts";

/** 1 is a turn nobody has looked at, "w" an agent waiting on an answer, "r" one still running */
const rows = (...flags: (0 | 1 | "w" | "r")[]) =>
  flags.map((f, i) => ({
    id: `w${i}`,
    unseen: f === 1,
    agent: f === "w" ? "waiting" : f === "r" ? "working" : "idle",
  }));

describe("unseenJump", () => {
  test("nearest unseen in the direction pressed", () => {
    const r = rows(0, 1, 0, 1, 0);
    expect(unseenJump(r, "w0", 1)).toEqual({ activate: "w1" });
    expect(unseenJump(r, "w2", 1)).toEqual({ activate: "w3" });
    expect(unseenJump(r, "w4", -1)).toEqual({ activate: "w3" });
    expect(unseenJump(r, "w2", -1)).toEqual({ activate: "w1" });
  });
  test("wraps when the direction runs out", () => {
    const r = rows(0, 1, 0, 1, 0);
    expect(unseenJump(r, "w4", 1)).toEqual({ activate: "w1" });
    expect(unseenJump(r, "w0", -1)).toEqual({ activate: "w3" });
  });
  test("the row on screen never counts, even if flagged", () => {
    const r = rows(0, 1, 0);
    expect(unseenJump(r, "w1", 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w1", -1)).toEqual({ activate: "w0" });
  });
  test("with none unseen, either direction is the first row, and nowhere once there", () => {
    const r = rows(0, 0, 0);
    expect(unseenJump(r, "w1", -1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w1", 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w0", 1)).toBeNull();
    expect(unseenJump([], null, -1)).toBeNull();
  });
  test("a waiting agent outranks a nearer unseen turn, in either direction", () => {
    const r = rows(1, 0, 0, "w", 1);
    expect(unseenJump(r, "w1", 1)).toEqual({ activate: "w3" });
    // w0 is one step up and unseen, but the waiting row wins by wrapping round
    expect(unseenJump(r, "w1", -1)).toEqual({ activate: "w3" });
  });
  test("waiting rows wrap and take turns like unseen ones", () => {
    const r = rows("w", 0, "w", 0);
    expect(unseenJump(r, "w0", 1)).toEqual({ activate: "w2" });
    expect(unseenJump(r, "w2", 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w3", -1)).toEqual({ activate: "w2" });
    expect(unseenJump(r, "w3", 1)).toEqual({ activate: "w0" });
  });
  test("once the only waiting row is on screen, unseen ones are next", () => {
    const r = rows(1, "w", 0);
    expect(unseenJump(r, "w1", 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w1", -1)).toEqual({ activate: "w0" });
  });
  test("a finished turn outranks a nearer running one", () => {
    const r = rows(1, "r", 0, "r");
    expect(unseenJump(r, "w2", 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w2", -1)).toEqual({ activate: "w0" });
  });
});

describe("needsYou", () => {
  test("counts the rows waiting on you or finished unseen, and names the best tier present", () => {
    expect(needsYou(rows(0, 1, 0, 1), null)).toEqual({ n: 2, tier: "unseen" });
    expect(needsYou(rows(1, "w", 0), null)).toEqual({ n: 2, tier: "waiting" });
  });
  test("the row on screen is looked at by definition", () => {
    expect(needsYou(rows(0, 1, 0), "w1")).toBeNull();
    expect(needsYou(rows("w", 1, 0), "w0")).toEqual({ n: 1, tier: "unseen" });
  });
  test("a running row owes nothing yet", () => {
    expect(needsYou(rows("r", 0, "r"), null)).toBeNull();
    expect(needsYou([], null)).toBeNull();
  });
  test("with nothing waiting or unseen, running rows take turns", () => {
    const r = rows("r", 0, "r", 0);
    expect(unseenJump(r, "w1", 1)).toEqual({ activate: "w2" });
    expect(unseenJump(r, "w1", -1)).toEqual({ activate: "w0" });
    // wraps the way the other tiers do
    expect(unseenJump(r, "w3", 1)).toEqual({ activate: "w0" });
  });
  test("the running row on screen is not the answer, so the first row still is", () => {
    const r = rows(0, "r", 0);
    expect(unseenJump(r, "w1", 1)).toEqual({ activate: "w0" });
    expect(unseenJump(r, "w1", -1)).toEqual({ activate: "w0" });
  });
});

describe("across machines", () => {
  const mac = (...flags: (0 | 1 | "w" | "r")[]) => ({ origin: "https://mac", rows: rows(...flags) });
  const box = (...flags: (0 | 1 | "w" | "r")[]) => ({ origin: "https://box", rows: rows(...flags) });
  test("the count is every machine's, and the tier the best anywhere", () => {
    expect(needsYouAcross(rows(0, 1), null, [mac("w", 0), box(1)])).toEqual({ n: 3, tier: "waiting" });
    expect(needsYouAcross(rows(0, 0), "w0", [mac(0, 1)])).toEqual({ n: 1, tier: "unseen" });
    expect(needsYouAcross(rows("r"), null, [mac("r"), box()])).toBeNull();
  });
  test("a waiting row on another machine outranks an unread turn here", () => {
    expect(owedJumpAcross(rows(0, 1), null, [mac(0, "w")])).toEqual({ origin: "https://mac", activate: "w1" });
  });
  test("at one tier this machine comes first, then the others in their order", () => {
    expect(owedJumpAcross(rows(0, "w"), null, [mac("w")])).toEqual({ origin: null, activate: "w1" });
    expect(owedJumpAcross(rows(0, 0), null, [mac(0), box(1)])).toEqual({ origin: "https://box", activate: "w0" });
  });
  test("the row on screen is looked at, so the same tier elsewhere is next", () => {
    expect(owedJumpAcross(rows("w", 0), "w0", [mac(0, "w")])).toEqual({ origin: "https://mac", activate: "w1" });
  });
  test("with nothing owed anywhere the fallback is this machine's: a running row, then the first", () => {
    expect(owedJumpAcross(rows(0, "r"), "w0", [mac(0)])).toEqual({ origin: null, activate: "w1" });
    expect(owedJumpAcross(rows(0, 0), "w1", [mac("r")])).toEqual({ origin: null, activate: "w0" });
    expect(owedJumpAcross(rows(0), "w0", [])).toBeNull();
  });
});
