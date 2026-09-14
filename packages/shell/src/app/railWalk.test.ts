import { describe, expect, test } from "bun:test";
import { railWalk } from "./railWalk.ts";

const owned = [{ id: "main" }, { id: "w1" }, { id: "w2" }];
const found = [{ id: "f0" }, { id: "f1" }];

describe("railWalk", () => {
  test("steps through the rows, main included", () => {
    expect(railWalk(owned, found, "w1", 1)).toEqual({ activate: "w2" });
    expect(railWalk(owned, found, "w2", -1)).toEqual({ activate: "w1" });
    expect(railWalk(owned, found, "main", 1)).toEqual({ activate: "w1" });
    expect(railWalk(owned, found, "w1", -1)).toEqual({ activate: "main" });
  });
  test("the loop wraps: down from the last row is main, up from main is the last row", () => {
    expect(railWalk(owned, found, "w2", 1)).toEqual({ activate: "main" });
    expect(railWalk(owned, found, "main", -1)).toEqual({ activate: "w2" });
  });
  test("a lone main has nowhere to go", () => {
    expect(railWalk([{ id: "main" }], [], "main", 1)).toBeNull();
    expect(railWalk([{ id: "main" }], [], "main", -1)).toBeNull();
  });
  test("a found row on screen walks the found rows, never into the loop", () => {
    expect(railWalk(owned, found, "f0", 1)).toEqual({ activate: "f1" });
    expect(railWalk(owned, found, "f1", -1)).toEqual({ activate: "f0" });
    expect(railWalk(owned, found, "f1", 1)).toBeNull();
  });
  test("up from the first found row is the way back to the owned rows", () => {
    expect(railWalk(owned, found, "f0", -1)).toEqual({ activate: "w2" });
    expect(railWalk([], found, "f0", -1)).toBeNull();
  });
  test("nothing on screen goes nowhere", () => {
    expect(railWalk(owned, found, null, 1)).toBeNull();
    expect(railWalk([], [], null, -1)).toBeNull();
  });
});
