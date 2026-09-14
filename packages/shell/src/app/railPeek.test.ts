import { describe, expect, test } from "bun:test";
import { walkModifier } from "./railPeek.ts";

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
