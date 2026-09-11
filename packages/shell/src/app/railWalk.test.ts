import { describe, expect, test } from "bun:test";
import { railWalk } from "./railWalk.ts";

const owned = [{ id: "main" }, { id: "w1" }, { id: "w2" }];
const found = [{ id: "f0" }, { id: "f1" }];

describe("railWalk", () => {
  test("steps through the tasks", () => {
    expect(railWalk(owned, found, "w1", false, 1)).toEqual({ activate: "w2" });
    expect(railWalk(owned, found, "w2", false, -1)).toEqual({ activate: "w1" });
  });
  test("the draft sits under main: down from main opens it, and down from it is the first task", () => {
    expect(railWalk(owned, found, "main", false, 1)).toEqual({ draft: true });
    expect(railWalk(owned, found, "main", true, 1)).toEqual({ activate: "w1" });
    expect(railWalk(owned, found, "w1", false, -1)).toEqual({ draft: true });
    expect(railWalk(owned, found, "w1", true, -1)).toEqual({ activate: "main" });
  });
  test("the loop wraps: down from the last row is main, up from main is the last row", () => {
    expect(railWalk(owned, found, "w2", false, 1)).toEqual({ activate: "main" });
    expect(railWalk(owned, found, "main", false, -1)).toEqual({ activate: "w2" });
    const one = [{ id: "main" }];
    expect(railWalk(one, [], "main", false, 1)).toEqual({ draft: true });
    expect(railWalk(one, [], "main", false, -1)).toEqual({ draft: true });
    expect(railWalk(one, [], null, true, 1)).toEqual({ activate: "main" });
    expect(railWalk(one, [], null, true, -1)).toEqual({ activate: "main" });
  });
  test("a found row on screen walks the found rows, never into the loop", () => {
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
    expect(railWalk([], [], null, true, 1)).toBeNull();
  });
});
