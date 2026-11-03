import { describe, expect, test } from "bun:test";
import {
  asBranches,
  filterCommands,
  insertAt,
  type MentionSpan,
  mentionableWorktrees,
  mentionIndex,
  mentionSpans,
  mentionTip,
  settled,
  triggerAt,
} from "./mentions.ts";

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

  test("a space stays inside the mention while the words still name a worktree", () => {
    const names = (q: string) => "message flash bug".startsWith(q.toLowerCase().trimEnd());
    expect(triggerAt("@message flash", 14, names)).toEqual({ kind: "file", query: "message flash", from: 0, to: 14 });
    // the space just typed holds the menu for the next word
    expect(triggerAt("@message ", 9, names)?.query).toBe("message ");
    // words that name nothing close it, as a path's space does
    expect(triggerAt("@message fla x", 14, names)).toBeNull();
    expect(triggerAt("@src ok", 7, names)).toBeNull();
    expect(triggerAt("@message flash", 14)).toBeNull();
    // the caret mid-word: the span runs to the end of that word
    expect(triggerAt("@message flash bug", 12, names)).toEqual({ kind: "file", query: "message fla", from: 0, to: 14 });
  });

  test("punctuation after the mention is the sentence going on, not the title's next word", () => {
    // the sibling match reads names without punctuation, so `toyon/fix ?` would still name the
    // branch and the pick would eat the `?`
    const names = (q: string) => q.toLowerCase().replace(/[^a-z0-9]/g, "") === "toyonfix";
    expect(triggerAt("@toyon/fix ?", 12, names)).toBeNull();
    expect(triggerAt("@toyon/fix !", 12, names)).toBeNull();
    expect(triggerAt("@toyon/fix , ", 13, names)).toBeNull();
    // a word with a letter in it, or the space just typed, still reads as the title
    expect(triggerAt("@toyon/fix ", 11, names)?.query).toBe("toyon/fix ");
    expect(triggerAt("@toyon/fix v2", 13, (q) => q.endsWith("v2"))?.query).toBe("toyon/fix v2");
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

  test("what the index does not know, a mail address, or a sigil mid-word is prose", () => {
    expect(spans("ask @kyle or me@example.com about @gone.ts")).toEqual([
      { kind: "text", text: "ask @kyle or me@example.com about @gone.ts" },
    ]);
    expect(spans("")).toEqual([]);
  });

  test("a web address is a link out, the sentence's punctuation and a bracket left outside", () => {
    expect(spans("see https://github.com/anthropics/claude-code/issues/95558, then @README.md")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "url",
        text: "https://github.com/anthropics/claude-code/issues/95558",
        href: "https://github.com/anthropics/claude-code/issues/95558",
      },
      { kind: "text", text: ", then " },
      { kind: "file", text: "@README.md", path: "README.md" },
    ]);
    expect(spans("(http://x.test/a_(b))")).toEqual([
      { kind: "text", text: "(" },
      { kind: "url", text: "http://x.test/a_(b)", href: "http://x.test/a_(b)" },
      { kind: "text", text: ")" },
    ]);
    // in a code span it is code, and a sigil on an address names nothing
    expect(spans("`https://x.test` @https://x.test")).toEqual([
      { kind: "code", text: "`https://x.test`", code: "https://x.test" },
      { kind: "text", text: " @" },
      { kind: "url", text: "https://x.test", href: "https://x.test" },
    ]);
  });

  test("an issue by its reference links as it does in the agent's prose; a path segment does not", () => {
    expect(spans("see toyon-dev/toyon#12, not /a/b#1")).toEqual([
      { kind: "text", text: "see " },
      { kind: "url", text: "toyon-dev/toyon#12", href: "https://github.com/toyon-dev/toyon/issues/12" },
      { kind: "text", text: ", not /a/b#1" },
    ]);
  });

  test("backticks hold code, as written, and a sigil inside them names nothing", () => {
    expect(spans("run `bun test` on @src/App.tsx")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "`bun test`", code: "bun test" },
      { kind: "text", text: " on " },
      { kind: "file", text: "@src/App.tsx", path: "src/App.tsx" },
    ]);
    expect(spans("`@src/App.tsx`")).toEqual([{ kind: "code", text: "`@src/App.tsx`", code: "@src/App.tsx" }]);
    // a run closes on a run of its own length, so a backtick can sit inside a double one; one
    // space either side is the backticks' room
    expect(spans("`` a`b `` and ` x `")).toEqual([
      { kind: "code", text: "`` a`b ``", code: "a`b" },
      { kind: "text", text: " and " },
      { kind: "code", text: "` x `", code: "x" },
    ]);
    // a backtick with no close is the character typed, and the sigil after it still opens a word
    expect(spans("a ` b @README.md")).toEqual([
      { kind: "text", text: "a ` b " },
      { kind: "file", text: "@README.md", path: "README.md" },
    ]);
    // a sigil right after a span is mid-word, as it is in the text
    expect(spans("`x`@README.md")).toEqual([
      { kind: "code", text: "`x`", code: "x" },
      { kind: "text", text: "@README.md" },
    ]);
  });

  test("a fence on a line of its own is a block, whose closing line break is the block's", () => {
    expect(spans("see:\n```ts\nconst a = 1;\n```\nok @README.md")).toEqual([
      { kind: "text", text: "see:\n" },
      { kind: "block", text: "```ts\nconst a = 1;\n```\n", code: "const a = 1;", lang: "ts" },
      { kind: "text", text: "ok " },
      { kind: "file", text: "@README.md", path: "README.md" },
    ]);
    // left open, the block runs to the end; three backticks round a word on one line are a span,
    // as markdown reads them, since a fence's info has no backtick in it
    expect(spans("```\nx")).toEqual([{ kind: "block", text: "```\nx", code: "x", lang: "" }]);
    expect(spans("```nnada```")).toEqual([{ kind: "code", text: "```nnada```", code: "nnada" }]);
    // the closing fence may be longer than the opening, never shorter
    expect(spans("````\n```\nx\n````")).toEqual([
      { kind: "block", text: "````\n```\nx\n````", code: "```\nx", lang: "" },
    ]);
  });

  test("one index per list, so every row shares the folder walk", () => {
    const files = ["a/b.ts"];
    expect(mentionIndex(files)).toBe(mentionIndex(files));
  });

  test("another worktree of the project resolves by its branch, with the sentence's punctuation left out", () => {
    const worktrees = new Map([["toyon/flash-bug", { id: "w1", title: "Message flash bug" }]]);
    const withRows = mentionIndex(["README.md"], worktrees);
    const flash: MentionSpan = {
      kind: "worktree",
      text: "@toyon/flash-bug",
      branch: "toyon/flash-bug",
      id: "w1",
      title: "Message flash bug",
    };
    expect(mentionSpans("do what @toyon/flash-bug did, here.", withRows)).toEqual([
      { kind: "text", text: "do what " },
      flash,
      { kind: "text", text: " did, here." },
    ]);
    // an archived row resolves too, and says so, so its mark opens the archived page
    const gone = new Map([["toyon/stay-awake", { id: "w2", title: "Stay awake", archived: true as const }]]);
    expect(mentionSpans("@toyon/stay-awake", mentionIndex(undefined, gone))).toEqual([
      {
        kind: "worktree",
        text: "@toyon/stay-awake",
        branch: "toyon/stay-awake",
        id: "w2",
        title: "Stay awake",
        archived: true,
      },
    ]);
    // no file list yet: the worktrees still resolve
    expect(mentionSpans("@toyon/flash-bug", mentionIndex(undefined, worktrees))).toEqual([flash]);
    expect(mentionSpans("@toyon/other", withRows)).toEqual([{ kind: "text", text: "@toyon/other" }]);
  });

  test("a worktree resolves by its title too, spaces and all, as the @ menu writes it", () => {
    const worktrees = new Map([
      ["toyon/code-review", { id: "w1", title: "Code review" }],
      ["toyon/code-review-2", { id: "w2", title: "Code review again" }],
      ["toyon/fixes", { id: "w3", title: "Fixes" }],
    ]);
    const index = mentionIndex(["README.md"], worktrees);
    const review: MentionSpan = {
      kind: "worktree",
      text: "@Code review",
      branch: "toyon/code-review",
      id: "w1",
      title: "Code review",
    };
    expect(mentionSpans("do what @Code review did, here.", index)).toEqual([
      { kind: "text", text: "do what " },
      review,
      { kind: "text", text: " did, here." },
    ]);
    // the longer of two titles that open alike is the one named; the punctuation after it is the sentence's
    expect(mentionSpans("see @Code review again.", index)).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "worktree",
        text: "@Code review again",
        branch: "toyon/code-review-2",
        id: "w2",
        title: "Code review again",
      },
      { kind: "text", text: "." },
    ]);
    // a title typed in any case keeps its characters; a word that runs past the title names nothing
    expect(mentionSpans("@code review", index)[0]).toEqual({ ...review, text: "@code review" });
    expect(mentionSpans("@Code reviewer", index)).toEqual([{ kind: "text", text: "@Code reviewer" }]);
    expect(mentionSpans("@Code", index)).toEqual([{ kind: "text", text: "@Code" }]);
    // a title of one word reads as a word: the sentence's punctuation is left out
    expect(mentionSpans("try @Fixes, then", index)).toEqual([
      { kind: "text", text: "try " },
      { kind: "worktree", text: "@Fixes", branch: "toyon/fixes", id: "w3", title: "Fixes" },
      { kind: "text", text: ", then" },
    ]);
  });

  test("a file of the branch's name is the file, and of a one-word title's name too", () => {
    const worktrees = new Map([["README.md", { id: "w1", title: "Readme" }]]);
    const index = mentionIndex(["README.md", "Readme"], worktrees);
    expect(mentionSpans("@README.md", index)).toEqual([{ kind: "file", text: "@README.md", path: "README.md" }]);
    expect(mentionSpans("@Readme", index)).toEqual([{ kind: "file", text: "@Readme", path: "Readme" }]);
  });

  test("a live row's mark carries what the rail says of it; an archived one has nothing to carry", () => {
    const live = new Map([
      ["toyon/fix", { id: "w1", title: "Fix", dot: "working" as const, state: "Agent working", at: 5 }],
    ]);
    expect(mentionSpans("@toyon/fix", mentionIndex(undefined, live))).toEqual([
      {
        kind: "worktree",
        text: "@toyon/fix",
        branch: "toyon/fix",
        id: "w1",
        title: "Fix",
        dot: "working",
        state: "Agent working",
        at: 5,
      },
    ]);
  });
});

describe("asBranches: the message as the agent reads it", () => {
  const index = mentionIndex(
    ["src/App.tsx"],
    new Map([
      ["toyon/code-review", { id: "w1", title: "Code review" }],
      ["toyon/gone", { id: "w2", title: "Gone", archived: true as const }],
    ]),
  );

  test("a worktree named by its title is named by its branch; everything else stays as written", () => {
    expect(asBranches("do what @Code review did to @src/App.tsx, see @toyon/gone.", index)).toBe(
      "do what @toyon/code-review did to @src/App.tsx, see @toyon/gone.",
    );
    expect(asBranches("@code review again", index)).toBe("@toyon/code-review again");
    expect(asBranches("ask @kyle about @Code reviewer", index)).toBe("ask @kyle about @Code reviewer");
    expect(asBranches("", index)).toBe("");
  });
});

describe("mentionableWorktrees: what a chat's references resolve against", () => {
  test("the open rows by branch, then the archive's record of any branch no open row has", () => {
    const open = [{ branch: "toyon/a", id: "w1", title: "A", dot: "idle" as const, state: "Idle", at: 3 }];
    const archived = [
      { id: "w0", title: "A before", branch: "toyon/a" },
      { id: "w9", title: "Gone", branch: "toyon/gone" },
    ];
    expect([...mentionableWorktrees(open, archived)]).toEqual([
      ["toyon/a", { id: "w1", title: "A", dot: "idle", state: "Idle", at: 3 }],
      ["toyon/gone", { id: "w9", title: "Gone", archived: true }],
    ]);
    expect(mentionableWorktrees([], undefined).size).toBe(0);
  });
});

describe("mentionTip: what a worktree mark's tip says", () => {
  test("a live row: the title, its state, when it was last sent to, and its dot", () => {
    const t = mentionTip({
      id: "w1",
      title: "Fix",
      dot: "working",
      state: "Agent working",
      at: Date.now() - 5 * 60000,
    });
    expect(t).toEqual({ text: "Fix", detail: ["Agent working", "last sent 5m ago"], dot: "working" });
  });

  test("an archived row: archived alone, and the hollow dot", () => {
    const t = mentionTip({ id: "w2", title: "Gone", archived: true, dot: "idle", state: "Idle", at: 1 });
    expect(t).toEqual({ text: "Gone", detail: ["archived"], dot: "archived" });
  });

  test("the branch follows the state, since the mark reads as the title", () => {
    expect(mentionTip({ id: "w1", title: "Fix", state: "Idle", branch: "toyon/fix" }).detail).toEqual([
      "Idle",
      "toyon/fix",
    ]);
    expect(mentionTip({ id: "w2", title: "Gone", archived: true, branch: "toyon/gone" }).detail).toEqual([
      "archived",
      "toyon/gone",
    ]);
  });

  test("the agent's side adds the directory its prose spelt, last", () => {
    expect(mentionTip({ id: "w1", title: "Fix", dir: "wt-1234" }).detail).toEqual(["wt-1234"]);
    expect(
      mentionTip({ id: "w2", title: "Gone", archived: true, branch: "toyon/gone", dir: "wt-9999" }).detail,
    ).toEqual(["archived", "toyon/gone", "wt-9999"]);
  });
});

describe("settled: the menu over a word that already draws as a mark", () => {
  const index = mentionIndex(
    ["src/App.tsx"],
    new Map([
      ["toyon/code-review", { id: "w1", title: "Code review" }],
      ["toyon/code-review-2", { id: "w2", title: "Code review again" }],
    ]),
  );

  test("the whole word is a branch, the changes set, a file or a folder", () => {
    expect(settled("@toyon/code-review", 0, index)).toBe(true);
    expect(settled("@changes", 0, index)).toBe(true);
    expect(settled("@src/App.tsx", 0, index)).toBe(true);
    expect(settled("@src/", 0, index)).toBe(true);
    expect(settled("@src", 0, index)).toBe(true);
  });

  test("a title as the pick wrote it, spaces and all, is settled wherever the caret sits in it", () => {
    const text = "see @Code review again btw";
    expect(settled(text, 4, index)).toBe(true);
    const names = (q: string) => "code review again".startsWith(q.toLowerCase().trimEnd());
    for (const caret of [7, 13, 22]) {
      const t = triggerAt(text, caret, names);
      expect(t?.from).toBe(4);
      expect(t && settled(text, t.from, index)).toBe(true);
    }
  });

  test("still being chosen: a title half typed, a prefix of a branch, a stranger", () => {
    expect(settled("@Code rev", 0, index)).toBe(false);
    expect(settled("@toyon/code", 0, index)).toBe(false);
    expect(settled("@toyon/other", 0, index)).toBe(false);
    expect(settled("@", 0, index)).toBe(false);
    // a sigil that is not the one asked about says nothing for it
    expect(settled("@toyon/code-review @x", 19, index)).toBe(false);
  });

  test("the word is read whole, so the caret's place in it does not matter", () => {
    const text = "see @toyon/code-review btw";
    const t = triggerAt(text, 11);
    expect(t && settled(text, t.from, index)).toBe(true);
  });
});
