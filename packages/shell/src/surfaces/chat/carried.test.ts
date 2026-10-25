import { describe, expect, test } from "bun:test";
import { spliceWords } from "../../state/attach.ts";
import { carriedWords } from "./carried.ts";

describe("what a dragged row writes", () => {
  test("a file is its mention, a folder ends in a slash, and the run ends in a space", () => {
    expect(
      carriedWords({
        kind: "paths",
        worktreeId: "w1",
        items: [
          { path: "src/App.tsx", folder: false },
          { path: "src/ui", folder: true },
        ],
      }),
    ).toBe("@src/App.tsx @src/ui/ ");
  });
  test("a worktree goes in by its title, as the @ menu writes it", () => {
    expect(
      carriedWords({ kind: "worktree", worktreeId: "w2", title: "Message flash bug", branch: "toyon/flash-bug" }),
    ).toBe("@Message flash bug ");
  });
});

describe("words dropped into the draft", () => {
  test("into an empty box", () => {
    expect(spliceWords("", 0, "@a ")).toEqual({ text: "@a ", caret: 3 });
  });
  test("at the end, after a space, with no second space", () => {
    expect(spliceWords("look at ", 8, "@a ")).toEqual({ text: "look at @a ", caret: 11 });
  });
  test("against a word gains the space an @ needs to read as a mention", () => {
    expect(spliceWords("look at", 7, "@a ")).toEqual({ text: "look at @a ", caret: 11 });
  });
  test("in the middle of a sentence, the rest follows the caret", () => {
    const { text, caret } = spliceWords("fix the bug", 4, "@a ");
    expect(text).toBe("fix @a the bug");
    expect(text.slice(caret)).toBe("the bug");
  });
  test("mid-word splits the word, since that is where the pointer let go", () => {
    expect(spliceWords("fixthe", 3, "@a ")).toEqual({ text: "fix @a the", caret: 7 });
  });
});
