import { describe, expect, test } from "bun:test";
import { filterCommands, insertAt, triggerAt } from "./mentions.ts";

// caret is written as | in the case names; the tests pass the index directly
const at = (text: string, caret = text.length) => triggerAt(text, caret);

describe("triggerAt: @ mentions", () => {
  test("opens at the start of the draft and after a space", () => {
    expect(at("@sr")).toEqual({ kind: "file", query: "sr", from: 0, to: 3 });
    expect(at("fix @sr")).toEqual({ kind: "file", query: "sr", from: 4, to: 7 });
    expect(at("@")).toEqual({ kind: "file", query: "", from: 0, to: 1 });
  });

  test("an address or a decorator is not a mention", () => {
    expect(at("me@example.com")).toBeNull();
    expect(at("a@b")).toBeNull();
  });

  test("a space ends it: the mention is chosen, the rest is prose", () => {
    expect(at("@src/App.tsx ")).toBeNull();
    expect(at("@src ok")).toBeNull();
  });

  test("paths type straight through", () => {
    expect(at("@src/pages/About.tsx")?.query).toBe("src/pages/About.tsx");
    expect(at("@a-b_c.d")?.query).toBe("a-b_c.d");
  });

  test("the caret can sit mid-draft; the span still covers the whole mention", () => {
    // "@src|more" - the query is what precedes the caret, the span is the whole word
    expect(triggerAt("@srcmore", 4)).toEqual({ kind: "file", query: "src", from: 0, to: 8 });
    // a later mention wins over an earlier one
    expect(triggerAt("@a @c", 5)).toEqual({ kind: "file", query: "c", from: 3, to: 5 });
  });

  test("the caret before the sigil is not inside anything", () => {
    expect(triggerAt("@src", 0)).toBeNull();
  });
});

describe("triggerAt: slash commands", () => {
  test("only at the very start, because that is the only place an agent dispatches one", () => {
    expect(at("/rev")).toEqual({ kind: "command", query: "rev", from: 0, to: 4 });
    expect(at("hi /rev")).toBeNull();
  });

  test("a space ends the name; the rest is the command's arguments", () => {
    expect(at("/review foo")).toBeNull();
    expect(triggerAt("/review foo", 4)).toEqual({ kind: "command", query: "rev", from: 0, to: 7 });
  });

  test("an mcp name is one token, colons and all", () => {
    expect(at("/mcp:linear:issue")).toEqual({ kind: "command", query: "mcp:linear:issue", from: 0, to: 17 });
  });
});

describe("insertAt", () => {
  test("replaces the span and reports where the caret lands", () => {
    expect(insertAt("fix @sr", { from: 4, to: 7 }, "@src/App.tsx ")).toEqual({
      text: "fix @src/App.tsx ",
      caret: 17,
    });
  });
  test("keeps whatever followed the span", () => {
    expect(insertAt("@sr later", { from: 0, to: 3 }, "@src/App.tsx ")).toEqual({
      text: "@src/App.tsx  later",
      caret: 13,
    });
  });
});

describe("filterCommands", () => {
  const cmds = [
    { name: "review", description: "look at a PR" },
    { name: "receive", description: "take delivery" },
    { name: "mcp:linear:issue", description: "open an issue" },
  ];
  test("an empty query keeps everything, in the agent's order", () => {
    expect(filterCommands(cmds, "").map((c) => c.name)).toEqual(["review", "receive", "mcp:linear:issue"]);
  });
  test("word starts rank above a scattered match", () => {
    expect(filterCommands(cmds, "rev")[0]!.name).toBe("review");
  });
  test("the description is searched too, and a miss drops the row", () => {
    expect(filterCommands(cmds, "delivery").map((c) => c.name)).toEqual(["receive"]);
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });
});
