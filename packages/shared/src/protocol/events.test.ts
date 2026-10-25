import { describe, expect, test } from "bun:test";
import { coalesce } from "./events.ts";

describe("coalesce", () => {
  test("adjacent deltas of one kind fold into one entry with the run's first seq; anything between breaks the run", () => {
    const entries = [
      { seq: 0, event: { type: "user-message", text: "go", ts: 1 } },
      { seq: 1, event: { type: "thinking-delta", text: "a" } },
      { seq: 2, event: { type: "thinking-delta", text: "b" } },
      { seq: 3, event: { type: "text-delta", text: "he" } },
      { seq: 4, event: { type: "text-delta", text: "llo" } },
      { seq: 5, event: { type: "turn-end", stopReason: "end_turn", ts: 2 } },
      { seq: 6, event: { type: "text-delta", text: "!" } },
    ] as const;
    expect(coalesce([...entries])).toEqual([
      entries[0],
      { seq: 1, event: { type: "thinking-delta", text: "ab" } },
      { seq: 3, event: { type: "text-delta", text: "hello" } },
      entries[5],
      entries[6],
    ]);
  });

  test("a folded run of prose keeps its latest chunk's message id", () => {
    const entries = [
      { seq: 0, event: { type: "text-delta", text: "a", messageId: "m1" } },
      { seq: 1, event: { type: "text-delta", text: "b", messageId: "m2" } },
      { seq: 2, event: { type: "text-delta", text: "c" } },
    ] as const;
    expect(coalesce([...entries])).toEqual([{ seq: 0, event: { type: "text-delta", text: "abc", messageId: "m2" } }]);
  });

  test("a watched command's output chunks fold under their row; another row's chunk breaks the run", () => {
    const entries = [
      { seq: 0, event: { type: "tool-start", toolId: "a", name: "shell", input: { command: "git push" } } },
      { seq: 1, event: { type: "tool-delta", toolId: "a", text: "tests " } },
      { seq: 2, event: { type: "tool-delta", toolId: "a", text: "1/2\n" } },
      { seq: 3, event: { type: "tool-delta", toolId: "b", text: "other" } },
      { seq: 4, event: { type: "tool-delta", toolId: "a", text: "2/2\n" } },
    ] as const;
    expect(coalesce([...entries])).toEqual([
      entries[0],
      { seq: 1, event: { type: "tool-delta", toolId: "a", text: "tests 1/2\n" } },
      entries[3],
      entries[4],
    ]);
  });
});
