import { describe, expect, test } from "bun:test";
import { blackGroundOf, luminance, sunkenOf, themeToCssVars, tokyoNight, toyonDark, toyonLight } from "./themes.ts";

/** CIE L* of an sRGB hex, the axis the ground ramp is measured on */
const lstar = (hex: string) => {
  const y = luminance(hex);
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
};

describe("blackGroundOf", () => {
  test("stands a dark theme on black, each ground keeping its distance above the floor", () => {
    const t = blackGroundOf(toyonDark);
    expect(t.colors.surface0).toBe("#000000");
    const was = toyonDark.colors;
    const floor = lstar(was.surface0);
    for (const k of ["surface1", "surface2", "element0", "element1", "border0", "border1"] as const) {
      expect(Math.abs(lstar(t.colors[k]) - (lstar(was[k]) - floor))).toBeLessThan(0.5);
    }
    // the chrome still parts from the floor by as much as it did
    expect(lstar(t.colors.surface1)).toBeGreaterThan(2);
    expect(lstar(t.colors.surface2)).toBeGreaterThan(lstar(t.colors.surface1));
  });

  test("moves nothing but the grounds, and keeps the theme's name", () => {
    const t = blackGroundOf(toyonDark);
    expect(t.id).toBe(toyonDark.id);
    expect(t.name).toBe(toyonDark.name);
    for (const k of ["text0", "text1", "text2", "red", "orange", "green", "blue", "diffAdd", "diffDel"] as const) {
      expect(t.colors[k]).toBe(toyonDark.colors[k]);
    }
    expect(t.syntax).toEqual(toyonDark.syntax);
    expect(themeToCssVars(t)["--accent"]).toBe(themeToCssVars(toyonDark)["--accent"]);
    // the recess cut under the chrome follows it down, and sits on the floor as before
    expect(sunkenOf(t)).toBe("#000000");
  });

  test("the darkest ground is the one that lands on black, whichever it is", () => {
    // Tokyo Night's ramp runs the other way: its floor is a control at rest, not surface0
    const t = blackGroundOf(tokyoNight);
    expect(t.colors.element1).toBe("#000000");
    expect(lstar(t.colors.surface0)).toBeGreaterThan(0);
  });

  test("a light theme has no black to go to, and a theme on black stays put", () => {
    expect(blackGroundOf(toyonLight)).toBe(toyonLight);
    const once = blackGroundOf(toyonDark);
    expect(blackGroundOf(once)).toBe(once);
  });
});
