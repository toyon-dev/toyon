import { describe, expect, test } from "bun:test";
import type { PrComment } from "@toyon/shared";
import { commentsLine, prPage, threadName, threadText } from "./prComments.ts";

const c = (id: string, at: number, over: Partial<PrComment> = {}): PrComment => ({
  id,
  author: "pat",
  body: `remark ${id}`,
  url: `https://github.com/o/r/pull/12#${id}`,
  at,
  ...over,
});

describe("the PR comments page", () => {
  test("reviews come first; each file's threads follow by line, with their answers folded in", () => {
    const page = prPage([
      c("c3", 3, { path: "src/b.ts", line: 9 }),
      c("c1", 1, { path: "src/b.ts", line: 40 }),
      c("r1", 2, { review: "changes_requested" }),
      c("c2", 4, { path: "src/b.ts", line: 40, replyTo: "c1", author: "sam" }),
      c("c4", 5, { path: "src/a.ts", line: 2 }),
      c("c5", 6, { path: "src/a.ts", line: 2, replyTo: "c0" }),
    ]);
    expect(page.reviews.map((t) => t.root.id)).toEqual(["r1"]);
    expect(page.files.map((f) => [f.path, f.threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])])).toEqual([
      // an answer whose thread is not listed stands as a thread of its own
      [
        "src/a.ts",
        [
          ["c4", []],
          ["c5", []],
        ],
      ],
      [
        "src/b.ts",
        [
          ["c3", []],
          ["c1", ["c2"]],
        ],
      ],
    ]);
  });

  test("a thread handed to the agent: who, where, the link, each remark quoted", () => {
    const root = c("c1", 1, {
      path: "src/state/store.ts",
      line: 12,
      startLine: 10,
      body: "Rename this.\n\nIt reads as a verb.",
    });
    const thread = { root, replies: [c("c2", 2, { author: "sam", body: "Agreed." })] };
    expect(threadText(thread)).toBe(
      [
        "pat commented on src/state/store.ts lines 10-12 in the pull request, https://github.com/o/r/pull/12#c1",
        "> Rename this.\n>\n> It reads as a verb.",
        "sam replied:\n> Agreed.",
      ].join("\n\n"),
    );
    expect(threadName(thread)).toBe("store.ts (10-12) from pat");
    const review = { root: c("r1", 1, { review: "approved", body: "" }), replies: [] };
    expect(threadText(review)).toBe("pat approved the pull request, https://github.com/o/r/pull/12#r1");
    expect(threadName(review)).toBe("review from pat");
  });

  test("the line over the box counts them and names who wrote them", () => {
    expect(commentsLine(1, [])).toEqual({ count: "1 comment", rest: "" });
    expect(commentsLine(3, ["kyle", "dana"])).toEqual({ count: "3 comments", rest: " from kyle and dana" });
    expect(commentsLine(7, ["kyle", "dana", "sam"])).toEqual({ count: "7 comments", rest: " from kyle and 2 others" });
  });
});
