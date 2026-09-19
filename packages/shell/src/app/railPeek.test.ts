import { describe, expect, test } from "bun:test";
import { modifierHeld, walkModifier } from "./railPeek.ts";

const mods = (m: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }>) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...m,
});

describe("walkModifier", () => {
  test("each spelling of the walk names the modifier whose release ends the peek", () => {
    expect(walkModifier(mods({ altKey: true }))).toBe("Alt");
    expect(walkModifier(mods({ ctrlKey: true }))).toBe("Control");
    expect(walkModifier(mods({ metaKey: true }))).toBe("Meta");
  });
  test("a bare key rides no modifier", () => {
    expect(walkModifier(mods({}))).toBeNull();
  });
});

describe("modifierHeld", () => {
  test("a later event reports the walk's modifier still down", () => {
    expect(modifierHeld(mods({ altKey: true }), "Alt")).toBe(true);
    expect(modifierHeld(mods({ ctrlKey: true }), "Control")).toBe(true);
    expect(modifierHeld(mods({ metaKey: true }), "Meta")).toBe(true);
  });
  test("or up, whichever other modifier it carries", () => {
    expect(modifierHeld(mods({}), "Alt")).toBe(false);
    expect(modifierHeld(mods({ metaKey: true }), "Alt")).toBe(false);
    expect(modifierHeld(mods({ altKey: true }), "Control")).toBe(false);
    expect(modifierHeld(mods({ altKey: true, ctrlKey: true }), "Meta")).toBe(false);
  });
});
