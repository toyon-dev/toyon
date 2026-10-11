import { describe, expect, test } from "bun:test";
import { measured, readoutText } from "./sizeReadout.ts";

describe("the preview's size readout", () => {
  test("says whole pixels: a flex box can measure a fraction, and the app inside sees none", () => {
    expect(readoutText({ w: 1749.4, h: 587.6 })).toBe("1749 × 588");
  });

  test("a move under a pixel reads the same, so the store has nothing new to draw", () => {
    expect(readoutText({ w: 800.2, h: 600 })).toBe(readoutText({ w: 800.4, h: 600 }));
  });

  test("a box laid out at nothing is hidden, not sized", () => {
    expect(measured({ w: 0, h: 0 })).toBe(false);
    expect(measured({ w: 800, h: 0 })).toBe(false);
    expect(measured({ w: 800, h: 600 })).toBe(true);
  });
});
