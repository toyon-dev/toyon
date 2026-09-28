import { describe, expect, test } from "bun:test";
import { blameLine } from "./blameLine.ts";

const DAY = 86_400_000;
const blame = {
  commits: [
    { sha: "a".repeat(40), author: "Kyle Shay", at: Date.now() - 3 * DAY, subject: "chat: keep attachments" },
    { sha: "b".repeat(40), author: "", at: Date.now() - 2 * DAY, subject: "" },
  ],
  lines: [0, -1, 1],
};

describe("blameLine", () => {
  test("who, how long ago, and the subject, separated by middots", () => {
    expect(blameLine(blame, 1)).toBe("Kyle Shay · 3d · chat: keep attachments");
  });

  test("a line only the working tree has says so", () => {
    expect(blameLine(blame, 2)).toBe("not committed yet");
  });

  test("a commit with no author or subject is its sha and its age", () => {
    expect(blameLine(blame, 3)).toBe("bbbbbbb · 2d");
  });

  test("a line the blame does not reach, or a file with none, is nothing", () => {
    expect(blameLine(blame, 4)).toBeNull();
    expect(blameLine({ commits: [], lines: [] }, 1)).toBeNull();
  });
});
