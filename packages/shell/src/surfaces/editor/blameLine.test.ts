import { describe, expect, test } from "bun:test";
import { blameCommit, blameLine } from "./blameLine.ts";

const DAY = 86_400_000;
const blame = {
  commits: [
    {
      sha: "a".repeat(40),
      author: "Kyle Shay",
      email: "k@x",
      at: Date.now() - 3 * DAY,
      subject: "chat: keep attachments",
    },
    { sha: "b".repeat(40), author: "", email: "", at: Date.now() - 2 * DAY, subject: "" },
  ],
  lines: [0, -1, 1],
};

describe("blameLine", () => {
  test("who and how long ago; the subject is the card's", () => {
    expect(blameLine(blame, 1)).toBe("Kyle Shay, 3d");
  });

  test("a line only the working tree has says so", () => {
    expect(blameLine(blame, 2)).toBe("not committed yet");
  });

  test("a commit with no author is its sha", () => {
    expect(blameLine(blame, 3)).toBe("bbbbbbb, 2d");
  });

  test("a line the blame does not reach, or a file with none, is nothing", () => {
    expect(blameLine(blame, 4)).toBeNull();
    expect(blameLine({ commits: [], lines: [] }, 1)).toBeNull();
  });
});

describe("blameCommit", () => {
  test("the commit a committed line names, and none for a typed or unreached line", () => {
    expect(blameCommit(blame, 1)?.subject).toBe("chat: keep attachments");
    expect(blameCommit(blame, 2)).toBeNull();
    expect(blameCommit(blame, 4)).toBeNull();
  });
});
