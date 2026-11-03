import { describe, expect, test } from "bun:test";
import { EMPTY_VIEWED, pruneViewed, pushViewed, VIEWED_CAP, viewedStep } from "./viewed.ts";

const live = (...ids: string[]) => new Set(ids);

describe("pushViewed", () => {
  test("the first choice seeds the list with where it was made from", () => {
    expect(pushViewed(EMPTY_VIEWED, "main", "a")).toEqual({ ids: ["main", "a"], at: 1 });
    expect(pushViewed(EMPTY_VIEWED, null, "a")).toEqual({ ids: ["a"], at: 0 });
  });
  test("choosing the row on screen again is not a step", () => {
    const v = pushViewed(EMPTY_VIEWED, "main", "a");
    expect(pushViewed(v, "a", "a")).toBe(v);
  });
  test("a choice from the middle of the walk drops what was ahead, as a browser's does", () => {
    const v = { ids: ["main", "a", "b"], at: 0 };
    expect(pushViewed(v, "main", "c")).toEqual({ ids: ["main", "c"], at: 1 });
  });
  test("the oldest entry goes past the cap", () => {
    let v = EMPTY_VIEWED;
    for (let i = 0; i < VIEWED_CAP + 5; i++) v = pushViewed(v, null, `w${i}`);
    expect(v.ids.length).toBe(VIEWED_CAP);
    expect(v.ids[0]).toBe("w5");
    expect(v.at).toBe(VIEWED_CAP - 1);
  });
});

describe("viewedStep", () => {
  const v = { ids: ["main", "a", "b"], at: 2 };
  test("back and forward move one entry", () => {
    expect(viewedStep(v, live("main", "a", "b"), "b", -1)).toEqual({ at: 1, activate: "a" });
    expect(viewedStep({ ...v, at: 1 }, live("main", "a", "b"), "a", 1)).toEqual({ at: 2, activate: "b" });
  });
  test("the walk's ends have nowhere to go", () => {
    expect(viewedStep(v, live("main", "a", "b"), "b", 1)).toBeNull();
    expect(viewedStep({ ...v, at: 0 }, live("main", "a", "b"), "main", -1)).toBeNull();
    expect(viewedStep(EMPTY_VIEWED, live("main"), "main", -1)).toBeNull();
  });
  test("a row that is gone, or the one on screen, is stepped over", () => {
    expect(viewedStep(v, live("main", "b"), "b", -1)).toEqual({ at: 0, activate: "main" });
    expect(viewedStep({ ids: ["main", "a", "a"], at: 2 }, live("main", "a"), "a", -1)).toEqual({
      at: 0,
      activate: "main",
    });
  });
});

describe("pruneViewed", () => {
  test("nothing gone, the same object back", () => {
    const v = { ids: ["main", "a"], at: 1 };
    expect(pruneViewed(v, live("main", "a"))).toBe(v);
  });
  test("a gone row leaves, and the repeat its going makes collapses; the stand moves with it", () => {
    expect(pruneViewed({ ids: ["main", "a", "main", "b"], at: 3 }, live("main", "b"))).toEqual({
      ids: ["main", "b"],
      at: 1,
    });
    expect(pruneViewed({ ids: ["main", "a", "main"], at: 1 }, live("main"))).toEqual({ ids: ["main"], at: 0 });
  });
  test("standing on the gone row lands on the nearest kept entry before it", () => {
    expect(pruneViewed({ ids: ["main", "a", "b"], at: 1 }, live("main", "b"))).toEqual({ ids: ["main", "b"], at: 0 });
    expect(pruneViewed({ ids: ["a", "b"], at: 0 }, live("b"))).toEqual({ ids: ["b"], at: 0 });
    expect(pruneViewed({ ids: ["a"], at: 0 }, live())).toEqual({ ids: [], at: -1 });
  });
});
