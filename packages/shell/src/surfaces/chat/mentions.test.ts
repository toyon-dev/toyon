import { describe, expect, test } from "bun:test";
import { filterCommands, insertAt, mentionIndex, mentionSpans, triggerAt } from "./mentions.ts";

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

  test("a second slash in the name is a path, not a command", () => {
    expect(at("/Users/me/app.ts")).toBeNull();
    expect(at("/src/")).toBeNull();
    expect(triggerAt("/src/app.ts is slow", 4)).toBeNull();
    // the slash has to fall inside the name: one in the arguments changes nothing
    expect(triggerAt("/review src/app.ts", 4)).toEqual({ kind: "command", query: "rev", from: 0, to: 7 });
  });
});

describe("triggerAt: shell commands", () => {
  test("a `!` draft offers no menu: a path or a slash inside it belongs to the shell", () => {
    expect(at("!ls @src")).toBeNull();
    expect(at("!/usr/bin/env")).toBeNull();
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
  test("a name match hides description matches: /plan should not list six things about planning", () => {
    const noisy = [
      { name: "plan", description: "make a plan" },
      { name: "usage", description: "show cost and plan usage" },
      { name: "ultracode", description: "research and plan a large change" },
    ];
    expect(filterCommands(noisy, "plan").map((c) => c.name)).toEqual(["plan"]);
  });
  test("the description is a fallback when no name matches, for an unguessable name", () => {
    expect(filterCommands(cmds, "delivery").map((c) => c.name)).toEqual(["receive"]);
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });
  test("names that match alike keep the list's order, which ranks whose they are over the alphabet", () => {
    const tied = [
      { name: "sync", description: "the person's own", origin: "project" as const },
      { name: "ship", description: "the agent's" },
    ];
    expect(filterCommands(tied, "s").map((c) => c.name)).toEqual(["sync", "ship"]);
    expect(filterCommands([...tied].reverse(), "s").map((c) => c.name)).toEqual(["ship", "sync"]);
  });
});

describe("mentionSpans: the references in a sent message", () => {
  const index = mentionIndex(["README.md", "src/App.tsx", "src/pages/About.tsx"]);
  const spans = (text: string) => mentionSpans(text, index);

  test("a file the index holds is a link; the words around it stay prose", () => {
    expect(spans("fix @src/App.tsx please")).toEqual([
      { kind: "text", text: "fix " },
      { kind: "file", text: "@src/App.tsx", path: "src/App.tsx" },
      { kind: "text", text: " please" },
    ]);
  });

  test("a folder resolves with or without its slash, and @changes always does", () => {
    expect(spans("@src/ and @src/pages")).toEqual([
      { kind: "folder", text: "@src/", path: "src" },
      { kind: "text", text: " and " },
      { kind: "folder", text: "@src/pages", path: "src/pages" },
    ]);
    expect(mentionSpans("review @changes", mentionIndex(undefined))).toEqual([
      { kind: "text", text: "review " },
      { kind: "changes", text: "@changes" },
    ]);
  });

  test("punctuation after a reference belongs to the sentence", () => {
    expect(spans("see @README.md.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "file", text: "@README.md", path: "README.md" },
      { kind: "text", text: "." },
    ]);
    expect(spans("(@src/App.tsx)")).toEqual([{ kind: "text", text: "(@src/App.tsx)" }]);
  });

  test("what the index does not know, an address, or a sigil mid-word is prose", () => {
    expect(spans("ask @kyle or me@example.com about @gone.ts")).toEqual([
      { kind: "text", text: "ask @kyle or me@example.com about @gone.ts" },
    ]);
    expect(spans("")).toEqual([]);
  });

  test("one index per list, so every row shares the folder walk", () => {
    const files = ["a/b.ts"];
    expect(mentionIndex(files)).toBe(mentionIndex(files));
  });
});
