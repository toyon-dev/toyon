import { describe, expect, test } from "bun:test";
import { navStep, stepIndex } from "./fullNav.ts";

const key = (
  key: string,
  mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {},
) => ({
  key,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});

describe("arrow keys in the full view", () => {
  test("left and right are a step along the list", () => {
    expect(navStep(key("ArrowLeft"))).toBe(-1);
    expect(navStep(key("ArrowRight"))).toBe(1);
  });

  test("any other key, or a modified arrow, is not", () => {
    expect(navStep(key("ArrowUp"))).toBeNull();
    expect(navStep(key("Escape"))).toBeNull();
    expect(navStep(key("ArrowRight", { shiftKey: true }))).toBeNull();
    expect(navStep(key("ArrowLeft", { metaKey: true }))).toBeNull();
    expect(navStep(key("ArrowLeft", { altKey: true }))).toBeNull();
    expect(navStep(key("ArrowLeft", { ctrlKey: true }))).toBeNull();
  });

  test("a step stops at the ends rather than wrapping", () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(1, 3, -1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBeNull();
    expect(stepIndex(2, 3, 1)).toBeNull();
    expect(stepIndex(0, 1, 1)).toBeNull();
  });
});
