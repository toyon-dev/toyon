import { describe, expect, test } from "bun:test";
import { STEP, slideAt, slideAxis } from "./slide.ts";

describe("whose a touch is", () => {
  test("nobody's until it has travelled", () => {
    expect(slideAxis({ dx: -5, dy: 3 })).toBe(null);
  });
  test("along the row toward its start is the slide", () => {
    expect(slideAxis({ dx: -20, dy: 4 })).toBe("slide");
  });
  test("up or down is the list's scroll", () => {
    expect(slideAxis({ dx: -6, dy: 20 })).toBe("other");
    expect(slideAxis({ dx: 4, dy: -20 })).toBe("other");
  });
  test("the other way is left to the swipe back", () => {
    expect(slideAxis({ dx: 30, dy: 2 })).toBe("other");
  });
});

describe("where a finger has brought the row", () => {
  test("short of the first rung it is on none, and follows the finger", () => {
    expect(slideAt(-30, 3)).toEqual({ step: 0, x: -30 });
  });
  test("each rung is a step further", () => {
    expect(slideAt(-STEP, 3).step).toBe(1);
    expect(slideAt(-2 * STEP - 10, 3).step).toBe(2);
    expect(slideAt(-3 * STEP, 3).step).toBe(3);
  });
  test("past the last rung the row gives rather than follows", () => {
    const past = slideAt(-3 * STEP - 100, 3);
    expect(past.step).toBe(3);
    expect(past.x).toBeGreaterThan(-3 * STEP - 100);
    expect(past.x).toBeLessThan(-3 * STEP);
  });
  test("a drag the other way leaves the row where it is", () => {
    expect(slideAt(40, 3)).toEqual({ step: 0, x: -0 });
  });
});
