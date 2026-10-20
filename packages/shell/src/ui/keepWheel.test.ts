import { describe, expect, test } from "bun:test";
import { keepsWheel } from "./hooks.ts";

const left = { ctrlKey: false, defaultPrevented: false };

describe("a wheel event the editor had no room for", () => {
  test("at rest is kept, so a gesture starting at the end of a line never becomes the swipe back", () => {
    expect(keepsWheel(left, 1)).toBe(true);
  });
  test("goes on to a pinch-zoomed window, which pans with it", () => {
    expect(keepsWheel(left, 2)).toBe(false);
    // a hair over 1 is rounding at the end of a pinch back out, not a zoom
    expect(keepsWheel(left, 1.005)).toBe(true);
  });
  test("a pinch, or one the editor already took, is left alone", () => {
    expect(keepsWheel({ ...left, ctrlKey: true }, 1)).toBe(false);
    expect(keepsWheel({ ...left, defaultPrevented: true }, 1)).toBe(false);
  });
});
