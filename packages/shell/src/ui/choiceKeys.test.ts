import { describe, expect, test } from "bun:test";
import { type ChoiceList, choiceKey, shellChord } from "./choiceKeys.ts";

const key = (
  key: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const three: ChoiceList = { count: 3, cursor: 1 };

describe("shellChord", () => {
  test("a chat switch or a rail walk is not a pick, however the card reads the bare key", () => {
    expect(shellChord(key("1", { metaKey: true }))).toBe(true);
    expect(shellChord(key("ArrowDown", { altKey: true }))).toBe(true);
    expect(shellChord(key("Tab", { ctrlKey: true }))).toBe(true);
    expect(shellChord(key("1"))).toBe(false);
    expect(shellChord(key("Enter"))).toBe(false);
  });
  test("the send chord is the card's own", () => {
    expect(shellChord(key("Enter", { metaKey: true }))).toBe(false);
    expect(shellChord(key("NumpadEnter", { ctrlKey: true }))).toBe(false);
    expect(shellChord(key("Enter", { altKey: true }))).toBe(true);
  });
});

describe("the list's keys on the rows", () => {
  test("a digit picks its row, counted from one, and a digit past the rows is nobody's", () => {
    expect(choiceKey(key("1"), false, three)).toEqual({ kind: "pick", at: 0, by: "digit" });
    expect(choiceKey(key("3"), false, three)).toEqual({ kind: "pick", at: 2, by: "digit" });
    expect(choiceKey(key("4"), false, three)).toBeNull();
    expect(choiceKey(key("0"), false, three)).toBeNull();
  });
  test("the arrows walk the cursor round the rows", () => {
    expect(choiceKey(key("ArrowDown"), false, three)).toEqual({ kind: "cursor", to: 2 });
    expect(choiceKey(key("ArrowDown"), false, { count: 3, cursor: 2 })).toEqual({ kind: "cursor", to: 0 });
    expect(choiceKey(key("ArrowUp"), false, { count: 3, cursor: 0 })).toEqual({ kind: "cursor", to: 2 });
  });
  test("enter picks the cursor's row; space only when the list says so", () => {
    expect(choiceKey(key("Enter"), false, three)).toEqual({ kind: "pick", at: 1, by: "enter" });
    expect(choiceKey(key("NumpadEnter"), false, three)).toEqual({ kind: "pick", at: 1, by: "enter" });
    expect(choiceKey(key(" "), false, three)).toBeNull();
    expect(choiceKey(key(" "), false, { ...three, spacePicks: true })).toEqual({ kind: "pick", at: 1, by: "enter" });
  });
  test("a list with no cursor has nothing for enter to pick, so enter is the send and the arrows walk nothing", () => {
    expect(choiceKey(key("Enter"), false, { count: 3 })).toEqual({ kind: "submit" });
    expect(choiceKey(key("ArrowDown"), false, { count: 3 })).toBeNull();
    expect(choiceKey(key("2"), false, { count: 3 })).toEqual({ kind: "pick", at: 1, by: "digit" });
  });
  test("the send chord, escape, and the shell's chords", () => {
    expect(choiceKey(key("Enter", { metaKey: true }), false, three)).toEqual({ kind: "submit" });
    expect(choiceKey(key("Escape"), false, three)).toEqual({ kind: "escape" });
    expect(choiceKey(key("1", { metaKey: true }), false, three)).toEqual({ kind: "chord" });
    expect(choiceKey(key("ArrowDown", { altKey: true }), false, three)).toEqual({ kind: "chord" });
  });
  test("a letter is the card's to read", () => {
    expect(choiceKey(key("n"), false, three)).toBeNull();
    expect(choiceKey(key("Tab"), false, three)).toBeNull();
  });
});

describe("the list's keys in a row's field", () => {
  test("enter is the row's answer, shift+enter a line break, the chord the send", () => {
    expect(choiceKey(key("Enter"), true, three)).toEqual({ kind: "field-enter" });
    expect(choiceKey(key("Enter", { shiftKey: true }), true, three)).toEqual({ kind: "typing" });
    expect(choiceKey(key("Enter", { metaKey: true }), true, three)).toEqual({ kind: "submit" });
  });
  test("escape and tab go back to the rows; shift+tab and the rest are the field's", () => {
    expect(choiceKey(key("Escape"), true, three)).toEqual({ kind: "field-leave" });
    expect(choiceKey(key("Tab"), true, three)).toEqual({ kind: "field-leave" });
    expect(choiceKey(key("Tab", { shiftKey: true }), true, three)).toEqual({ kind: "typing" });
    expect(choiceKey(key("1"), true, three)).toEqual({ kind: "typing" });
    expect(choiceKey(key("ArrowDown"), true, three)).toEqual({ kind: "typing" });
  });
});
