import { describe, expect, test } from "bun:test";
import { dockWidthAt } from "./dockWidth.ts";

describe("dockWidthAt", () => {
  test("a dock before its handle is measured from its left edge", () => {
    expect(dockWidthAt({ left: 100, right: 400 }, "left", 250)).toBe(150);
  });
  test("a dock after its handle is measured from its right edge", () => {
    expect(dockWidthAt({ left: 600, right: 900 }, "right", 700)).toBe(200);
  });
  test("a pointer past the far edge goes negative, which the clamp answers", () => {
    expect(dockWidthAt({ left: 100, right: 400 }, "left", 60)).toBeLessThan(0);
  });
});
