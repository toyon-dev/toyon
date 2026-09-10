import { describe, expect, test } from "bun:test";
import { railWalk } from "./railWalk.ts";

const owned = [{ id: "w0" }, { id: "w1" }, { id: "w2" }];
const found = [{ id: "f0" }, { id: "f1" }];

describe("railWalk", () => {
  test("steps through the owned rows and stops at the top", () => {
    expect(railWalk(owned, found, "w1", false, 1)).toEqual({ activate: "w2" });
    expect(railWalk(owned, found, "w1", false, -1)).toEqual({ activate: "w0" });
    expect(railWalk(owned, found, "w0", false, -1)).toBeNull();
  });
  test("down from the last owned row is the draft, never the found list", () => {
    expect(railWalk(owned, found, "w2", false, 1)).toEqual({ draft: true });
    expect(railWalk(owned, found, "w2", true, 1)).toBeNull();
    expect(railWalk(owned, found, "w2", true, -1)).toEqual({ activate: "w2" });
  });
  test("a found row on screen walks the found rows", () => {
    expect(railWalk(owned, found, "f0", false, 1)).toEqual({ activate: "f1" });
    expect(railWalk(owned, found, "f1", false, -1)).toEqual({ activate: "f0" });
    expect(railWalk(owned, found, "f1", false, 1)).toBeNull();
  });
  test("up from the first found row is the way back to the owned rows", () => {
    expect(railWalk(owned, found, "f0", false, -1)).toEqual({ activate: "w2" });
    expect(railWalk([], found, "f0", false, -1)).toBeNull();
  });
  test("nothing on screen goes nowhere", () => {
    expect(railWalk(owned, found, null, false, 1)).toBeNull();
    expect(railWalk([], [], null, true, -1)).toBeNull();
  });
});
