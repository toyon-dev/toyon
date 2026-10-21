import { describe, expect, test } from "bun:test";
import type { AskChoice } from "@toyon/shared";
import { rejectRow, typingStart } from "./permissionNote.ts";

const plan: AskChoice[] = [
  { id: "auto", name: "Yes, and auto-accept edits", kind: "allow_once" },
  { id: "manual", name: "Yes, manually approve edits", kind: "allow_once" },
  { id: "no", name: "No, keep planning", kind: "reject_once" },
];

const key = (k: string, over: Partial<KeyLikeAll> = {}): KeyLikeAll => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});
type KeyLikeAll = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

describe("rejectRow", () => {
  test("the no is where words go", () => {
    expect(rejectRow(plan)).toBe(2);
  });
  test("a card with no refusal names no row", () => {
    expect(rejectRow(plan.slice(0, 2))).toBeNull();
  });
});

describe("typingStart", () => {
  test("a letter starts writing, and is the first thing written", () => {
    expect(typingStart(key("a"))).toBe("a");
    expect(typingStart(key("A", { shiftKey: true }))).toBe("A");
    expect(typingStart(key("?"))).toBe("?");
  });
  test("the list's own keys do not", () => {
    for (const k of ["1", "9", "n", " ", "Enter", "Escape", "ArrowDown", "Tab"]) expect(typingStart(key(k))).toBeNull();
  });
  test("a chord is the shell's", () => {
    expect(typingStart(key("k", { metaKey: true }))).toBeNull();
    expect(typingStart(key("k", { ctrlKey: true }))).toBeNull();
    expect(typingStart(key("k", { altKey: true }))).toBeNull();
  });
});
