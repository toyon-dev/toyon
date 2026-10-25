import { describe, expect, test } from "bun:test";
import {
  blackGroundOf,
  contrastRatio,
  luminance,
  sunkenOf,
  themeToCssVars,
  tokyoNight,
  toyonDark,
  toyonLight,
} from "./themes.ts";

/** CIE L* of an sRGB hex, the axis the ground ramp is measured on */
const lstar = (hex: string) => {
  const y = luminance(hex);
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
};

describe("blackGroundOf", () => {
  test("stands both screen grounds on black, the rest keeping their contrast against the floor", () => {
    const t = blackGroundOf(toyonDark);
    // the chat's ground and the phone list's: every screen, and the status bar above it, is black
    expect(t.colors.surface0).toBe("#000000");
    expect(t.colors.surface1).toBe("#000000");
    const was = toyonDark.colors;
    for (const k of ["surface2", "element0", "element1", "border0", "border1"] as const) {
      expect(
        Math.abs(contrastRatio(t.colors[k], t.colors.surface0) - contrastRatio(was[k], was.surface0)),
      ).toBeLessThan(0.05);
      expect(lstar(t.colors[k])).toBeLessThan(lstar(was[k]));
    }
    // the idle dot (surface2) still reads on the black list
    expect(lstar(t.colors.surface2)).toBeGreaterThan(12);
  });

  test("the quiet text tiers keep the contrast they had against the floor, body text stays", () => {
    const t = blackGroundOf(toyonDark);
    expect(t.colors.text0).toBe(toyonDark.colors.text0);
    for (const k of ["text1", "text2"] as const) {
      const was = contrastRatio(toyonDark.colors[k], toyonDark.colors.surface0);
      expect(Math.abs(contrastRatio(t.colors[k], t.colors.surface0) - was)).toBeLessThan(0.05);
      expect(lstar(t.colors[k])).toBeLessThan(lstar(toyonDark.colors[k]));
    }
    // the ladder still steps: body, then quiet, then the hint
    expect(lstar(t.colors.text0)).toBeGreaterThan(lstar(t.colors.text1) + 20);
    expect(lstar(t.colors.text1)).toBeGreaterThan(lstar(t.colors.text2) + 10);
  });

  test("moves nothing else, and keeps the theme's name", () => {
    const t = blackGroundOf(toyonDark);
    expect(t.id).toBe(toyonDark.id);
    expect(t.name).toBe(toyonDark.name);
    for (const k of ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "diffAdd", "diffDel"] as const) {
      expect(t.colors[k]).toBe(toyonDark.colors[k]);
    }
    expect(t.syntax).toEqual(toyonDark.syntax);
    expect(themeToCssVars(t)["--accent"]).toBe(themeToCssVars(toyonDark)["--accent"]);
    // the recess cut under the chrome has nowhere lower to go: it is the black it sits in
    expect(sunkenOf(t)).toBe("#000000");
  });

  test("a ramp that runs the other way measures from its own darkest ground", () => {
    // Tokyo Night's floor is a control at rest, not surface0: it lands on black with the screens
    const t = blackGroundOf(tokyoNight);
    expect(t.colors.element1).toBe("#000000");
    expect(t.colors.surface0).toBe("#000000");
    expect(lstar(t.colors.text1)).toBeLessThan(lstar(tokyoNight.colors.text1));
  });

  test("a light theme has no black to go to, and a theme on black stays put", () => {
    expect(blackGroundOf(toyonLight)).toBe(toyonLight);
    const once = blackGroundOf(toyonDark);
    expect(blackGroundOf(once)).toBe(once);
  });
});
