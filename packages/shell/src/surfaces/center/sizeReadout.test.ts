import { describe, expect, test } from "bun:test";
import { isChange, readoutText } from "./sizeReadout.ts";

describe("the preview's size readout", () => {
  test("says whole pixels: a flex box can measure a fraction, and the app inside sees none", () => {
    expect(readoutText({ w: 1749.4, h: 587.6 })).toBe("1749 × 588");
  });

  test("the first measure is not a change", () => {
    expect(isChange(null, { w: 800, h: 600 })).toBe(false);
  });

  test("a box laid out at nothing was hidden, not resized", () => {
    expect(isChange({ w: 800, h: 600 }, { w: 0, h: 0 })).toBe(false);
    expect(isChange({ w: 800, h: 600 }, { w: 800, h: 0 })).toBe(false);
  });

  test("a move under a pixel is no change: the numbers would not read differently", () => {
    expect(isChange({ w: 800.2, h: 600 }, { w: 800.4, h: 600 })).toBe(false);
  });

  test("either side moving a pixel is a change", () => {
    expect(isChange({ w: 800, h: 600 }, { w: 801, h: 600 })).toBe(true);
    expect(isChange({ w: 800, h: 600 }, { w: 800, h: 599 })).toBe(true);
  });
});
