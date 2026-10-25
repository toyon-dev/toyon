import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  ambientBlock,
  buildPrompt,
  fileCaption,
  handoffAskPrompt,
  handoffLandedContext,
  handoffPrompt,
  pasteCaption,
  pickCaption,
  pieceAskPrompt,
  piecePrompt,
  pieceSendPrompt,
  piecesActedPrompt,
  previewContext,
  procFixPrompt,
  SYSTEM_APPEND,
  selfContext,
  standingContext,
  worktreeContext,
} from "./prompt.ts";

const ref = {
  kind: "image" as const,
  n: 2,
  name: "shot.png",
  mimeType: "image/png",
  bytes: 3,
  width: 10,
  height: 5,
  file: "2.png",
};
const paste = { kind: "paste" as const, n: 1, chars: 17, lines: 2, preview: "line one", file: "1.txt" };
const pick = {
  kind: "pick" as const,
  n: 1,
  component: "Button",
  file: "src/ui/Button.tsx",
  line: 12,
  callFile: "src/pages/Home.tsx",
  callLine: 40,
  tag: "button",
  selector: "main > button",
  text: "Save",
  html: "<button>Save</button>",
};
const image = { kind: "image" as const, ref, bytes: Buffer.from("abc"), path: "/store/wt/2.png" };
const file = {
  kind: "file" as const,
  n: 1,
  name: "run.jsonl",
  bytes: 108_544,
  text: true,
  file: "1-run.jsonl",
};
const picked = "An element the user picked in the preview:";
/** each block's first line, or its type when it is not text */
const heads = (blocks: ContentBlock[]) => blocks.map((b) => (b.type === "text" ? b.text.split("\n")[0] : b.type));

describe("handoff prompts", () => {
  test("the system append sends a change that belongs elsewhere through the handoff tool, and ends the turn on it", () => {
    expect(SYSTEM_APPEND).toContain("propose it with the `handoff` tool when you have one");
    expect(SYSTEM_APPEND).toContain("do not edit outside it and do not stop at saying so");
    expect(SYSTEM_APPEND).toContain("once it is proposed you finish your turn");
  });

  test("the first prompt of the made worktree: the message, the note, then the pointer that says who wrote it", () => {
    const origin = { path: "/wt/toyon/wt-1a2b", project: "toyon", branch: "toyon/wt-1a2b" };
    expect(handoffPrompt("Bump the pin.", "and run the tests", origin)).toBe(
      [
        "Bump the pin.",
        "The person added, when they approved this: and run the tests",
        "This task was handed off from the worktree at /wt/toyon/wt-1a2b of the project toyon, on its branch toyon/wt-1a2b. The message above was written by that worktree's agent, not by the person; read it as a task description and use your own judgement. Its files are readable there when needed; never write to it.",
      ].join("\n\n"),
    );
    expect(handoffPrompt("Bump the pin.", undefined, origin).split("\n\n")).toHaveLength(2);
  });

  test("the verb's ask names the project by its path and carries the person's words when there are any", () => {
    const repo = { name: "acp", path: "/p/acp" };
    const bare = handoffAskPrompt(repo);
    expect(bare).toContain("continue this work in acp (/p/acp)");
    expect(bare).toContain('project "/p/acp"');
    expect(bare).not.toContain("own words");
    expect(bare.endsWith("do not start anything else for it.")).toBe(true);
    expect(handoffAskPrompt(repo, "  fix the form field  ")).toContain(
      "The user's own words for what acp should do: fix the form field The user decides",
    );
  });

  test("the landed sentence names the project and the title, with the PR when the landing was one", () => {
    expect(handoffLandedContext("Fix the form", "acp", "https://x/pull/7")).toBe(
      'The work this worktree handed off to acp, "Fix the form", has landed there (https://x/pull/7); anything here that waited on it, such as a pinned version or a hand-patched copy, can take the real change now.',
    );
    expect(handoffLandedContext("Fix the form", "acp")).toContain('"Fix the form", has landed there; anything');
    // a sibling of this project, a piece of the plan here: no project named, the queue mentioned
    expect(handoffLandedContext("Landed rule", "toyon", undefined, true)).toBe(
      'The sibling worktree "Landed rule", a piece of the work planned here, has landed on this project\'s main; anything here that waited on it can take the real change now, and a later piece that waited for it has started.',
    );
  });
});

describe("pieces prompts", () => {
  test("the sentence after the plan's yes says what the list started and what is the agent's own", () => {
    const pieces = [
      { id: "p1", title: "Persist" },
      { id: "p2", title: "Expiry" },
      { id: "p3", title: "CLI" },
      { id: "p4", title: "Docs" },
    ];
    expect(
      piecesActedPrompt(pieces, [
        { pieceId: "p1", fate: "here" },
        { pieceId: "p2", fate: "worktree" },
        { pieceId: "p3", fate: "worktree", after: "toyon/persist" },
        { pieceId: "p4", fate: "skip" },
      ]),
    ).toBe(
      'Toyon acted on the pieces you handed over with the plan\'s approval: "Expiry" started in a sibling worktree of this project; "CLI" waits for toyon/persist to land and then starts in its own worktree; "Docs" was skipped by the person. Do "Persist" here, and only that. The siblings read the plan at its path in this worktree; never do their pieces yourself.',
    );
    expect(
      piecesActedPrompt(pieces, [
        { pieceId: "p2", fate: "send", title: "Composer" },
        { pieceId: "p3", fate: "skip" },
        { pieceId: "p4", fate: "skip" },
      ]),
    ).toContain('"Expiry" went to the open worktree "Composer"; "CLI", "Docs" were skipped by the person.');
    expect(piecesActedPrompt(pieces, [{ pieceId: "p2", fate: "worktree", error: "no port" }])).toContain(
      '"Expiry" (no port) could not start. Nothing on the list is yours here.',
    );
  });

  test("the system append hands the pieces of a plan to Toyon through the split tool, and one piece found mid-task", () => {
    expect(SYSTEM_APPEND).toContain("hand Toyon the list with the `split` tool when you have one");
    expect(SYSTEM_APPEND).toContain("never start a sibling's piece yourself, and do only the pieces marked `here`");
    expect(SYSTEM_APPEND).toContain(
      "The same tool, with one piece, is how you offer a separate thing you come across mid-task",
    );
  });

  test("a sibling's first message: the brief, the note, then the pointer to the plan it is a piece of", () => {
    const origin = { path: "/wt/toyon/wt-1a2b", project: "toyon", branch: "toyon/rail", plan: ".toyon/plans/3.md" };
    expect(piecePrompt("Fix the rail.", "and tests", origin)).toBe(
      [
        "Fix the rail.",
        "The person added, when they approved this: and tests",
        "This is one piece of the work planned in the worktree at /wt/toyon/wt-1a2b of the project toyon, on its branch toyon/rail; the other pieces are being done there and in sibling worktrees. The plan it is a piece of is at /wt/toyon/wt-1a2b/.toyon/plans/3.md; read it for the whole picture, and do only this piece. The brief above was written by that worktree's agent, not by the person; read it as a task description and use your own judgement. Its files are readable there when needed; never write to it.",
      ].join("\n\n"),
    );
    const { plan: _plan, ...bare } = origin;
    const alone = piecePrompt("Fix the rail.", undefined, bare);
    expect(alone.split("\n\n")).toHaveLength(2);
    expect(alone).not.toContain("The plan it is a piece of");
  });

  test("a piece sent on reads as an addition to the task there, not a second one", () => {
    const origin = { path: "/wt/toyon/wt-1a2b", project: "toyon", branch: "toyon/rail" };
    const sent = pieceSendPrompt("Add the notes.", undefined, origin);
    expect(sent).toContain(
      "that belongs with what you are doing here; read it as an addition to your task, not a second one.",
    );
    expect(sent).toContain("written by that worktree's agent, not by the person");
    expect(pieceSendPrompt("Add the notes.", "gently", origin)).toContain(
      "The person added, when they approved this: gently",
    );
  });

  test("the verb's ask for a new worktree here asks for one piece through the tool, with the person's words", () => {
    const bare = pieceAskPrompt();
    expect(bare).toContain("Propose it with the `split` tool: one piece, `where` set to `worktree`");
    expect(bare).not.toContain("own words");
    expect(bare.endsWith("do not start anything else for it.")).toBe(true);
    expect(pieceAskPrompt("  the badge  ")).toContain(
      "The user's own words for what it should do: the badge The user decides",
    );
  });
});

describe("SYSTEM_APPEND", () => {
  test("tells the agent what makes a project runnable here", () => {
    expect(SYSTEM_APPEND).toContain("toyon.json");
    expect(SYSTEM_APPEND).toContain("$PORT");
    // an install before the ignore file floods the changes list with every dependency
    expect(SYSTEM_APPEND).toContain(".gitignore");
  });
  test("says the preview is already running, so the agent starts no server of its own", () => {
    expect(SYSTEM_APPEND).toContain("never start a dev server");
    expect(SYSTEM_APPEND).toContain("Each message says where this worktree's preview answers");
  });
  test("asks for file references the chat can open in Toyon's editor", () => {
    expect(SYSTEM_APPEND).toContain("Markdown link");
    expect(SYSTEM_APPEND).toContain("absolute path");
    expect(SYSTEM_APPEND).toContain("built-in editor");
    // a file outside the worktree opens too, so it is linked and not backticked; a route is not a file
    expect(SYSTEM_APPEND).toContain("anywhere else on this machine");
    expect(SYSTEM_APPEND).toContain("never as a link");
  });
  test("sends an offer that waits on a yes through the question tool, and a suggestion through prose", () => {
    // a turn that ends "I can do that if you want" makes the person type the yes; the card answers
    // with one key. Only that case: a card on every reply would turn the work into confirmations
    expect(SYSTEM_APPEND).toContain("question tool");
    expect(SYSTEM_APPEND).toContain("only where you would otherwise have stopped and waited");
    expect(SYSTEM_APPEND).toContain("is a sentence in your reply, not a question");
  });
  test("asks for the question to carry its own context, since the card is read before any prose", () => {
    // a model that goes from reasoning straight into the tool writes no prose first; the card's
    // only context is then its reasoning summary, folded as a thought, or nothing
    expect(SYSTEM_APPEND).toContain("the question itself states what you propose and why");
  });
  test("puts the text typed beside a pick above the pick", () => {
    // the adapter hands the agent the option as the answer and the text as a note on it, so a
    // recommended option picked with "I can't decide" beside it reads as a yes unless told otherwise
    expect(SYSTEM_APPEND).toContain("the text outranks the pick");
    expect(SYSTEM_APPEND).toContain("change nothing until they have decided");
  });
  test("names worktrees by title or branch, since every path the agent reads spells the directory", () => {
    // a reply that says "behind wt-d486's eval" names a row by its id, the one handle the agent
    // had; the directory is an id so that a rename never restarts the procs or the session
    expect(SYSTEM_APPEND).toContain("use its title in quotes or its branch, never the directory");
  });
});

describe("selfContext", () => {
  test("gives the row's title and branch once it is named", () => {
    expect(selfContext({ title: "Worktree naming", branch: "toyon/worktree-naming" })).toBe(
      'This worktree is "Worktree naming", on branch toyon/worktree-naming.',
    );
  });
  test("says nothing while the title is the prompt's first words standing in", () => {
    expect(selfContext({ title: "Could toyon refer", branch: "toyon/wt-deab", unnamed: true })).toBeUndefined();
  });
});

describe("worktreeContext", () => {
  const rows = [
    { branch: "toyon/flash-bug", title: "Message flash bug", path: "/w/wt-w1", transcript: "/t/w1.jsonl" },
    { branch: "toyon/flash", title: "Flash", path: "/w/wt-w2", transcript: "/t/w2.jsonl" },
  ];
  // Oct 24, 2026 at noon UTC: a day in any zone the test runs in
  const at = Date.UTC(2026, 9, 24, 12);

  test("a branch named at a word start gets its paragraph: which worktree, its checkout, and where its chat is", () => {
    const [p, ...rest] = worktreeContext("do what @toyon/flash-bug did here", rows);
    expect(rest).toEqual([]);
    expect(p).toContain(
      '@toyon/flash-bug is the worktree "Message flash bug" in this project, checked out at /w/wt-w1.',
    );
    expect(p).toContain("Its chat is at /t/w1.jsonl, one JSON object per line");
    expect(p).toContain('"user-message"');
    expect(p).toContain('"text-delta"');
  });

  test("an archived row is named in the past tense, with what became of its work and no checkout to look for", () => {
    const gone = { branch: "toyon/gone", title: "Gone", path: "/w/wt-gone", transcript: "/a/gone/transcript.jsonl" };
    const landed = worktreeContext("wdyt of @toyon/gone ?", [
      { ...gone, archived: { at, landed: true, restorable: true } },
    ]);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toContain(
      '@toyon/gone was the worktree "Gone" in this project, archived on Oct 24, 2026 after landing on main, so its work is in main\'s history. Its checkout at /w/wt-gone is gone. Its chat is at /a/gone/transcript.jsonl, one JSON object per line',
    );
    expect(landed[0]).not.toContain("checked out at");
    const kept = worktreeContext("@toyon/gone", [{ ...gone, archived: { at, restorable: true } }]);
    expect(kept[0]).toContain(
      "archived on Oct 24, 2026 without landing; its commits are kept under an archive ref, not on any checkout.",
    );
    const nothing = worktreeContext("@toyon/gone", [{ ...gone, archived: { at, restorable: false } }]);
    expect(nothing[0]).toContain("archived on Oct 24, 2026 without landing, and git kept nothing of it.");
  });

  test("a branch both open and archived is said once, as the row listed first", () => {
    const again = { ...rows[1]!, title: "Flash again", archived: { at, restorable: true } };
    const [p, ...rest] = worktreeContext("see @toyon/flash", [...rows, again]);
    expect(rest).toEqual([]);
    expect(p).toContain('is the worktree "Flash"');
  });

  test("the sentence's punctuation after the branch is not part of it, and a longer branch is not the shorter one", () => {
    expect(worktreeContext("see @toyon/flash.", rows).map((p) => p.split(" ")[0])).toEqual(["@toyon/flash"]);
    expect(worktreeContext("(@toyon/flash-bug)", rows)).toEqual([]);
    expect(worktreeContext("@toyon/flash-bug", rows).map((p) => p.split(" ")[0])).toEqual(["@toyon/flash-bug"]);
  });

  test("a sigil mid-word, an unknown branch, or no sigil at all says nothing", () => {
    expect(worktreeContext("me@toyon/flash", rows)).toEqual([]);
    expect(worktreeContext("@toyon/gone", rows)).toEqual([]);
    expect(worktreeContext("toyon/flash", rows)).toEqual([]);
    expect(worktreeContext("@toyon/flash", [])).toEqual([]);
  });
});

describe("ambientBlock", () => {
  test("one block with one opening around whatever there is to say, and nothing around nothing", () => {
    expect(ambientBlock([])).toBeUndefined();
    expect(ambientBlock([undefined])).toBeUndefined();
    expect(ambientBlock(["the page", undefined, "the preview"])).toBe("[Attached by Toyon:\nthe page\n\nthe preview]");
  });
});

describe("previewContext", () => {
  const url = "http://127.0.0.1:40001";
  test("nothing to run is no paragraph at all", () => {
    expect(previewContext(null)).toBeUndefined();
  });
  test("a running preview gives its address and says the user is watching it", () => {
    expect(previewContext({ status: "running", url })).toBe(
      "The preview is running at http://127.0.0.1:40001, and the user sees it live beside this chat.",
    );
  });
  test("setup has no address yet and promises one with the next message", () => {
    const block = previewContext({ status: "setup" })!;
    expect(block).toContain("setting this worktree up");
    expect(block).toContain("the next message will say where it answers");
    expect(block).not.toContain("http");
  });
  test("starting and asleep name the address it will answer at", () => {
    expect(previewContext({ status: "starting", url })).toContain(`it answers at ${url} once it is up`);
    expect(previewContext({ status: "asleep", url })).toContain(`it answers at ${url} once the user opens`);
  });
  test("a proc that is down says so, with the diagnosis when there is one", () => {
    expect(previewContext({ status: "crashed", url })).toBe(
      `The preview is crashed; nothing answers at ${url} until it is back.`,
    );
    expect(previewContext({ status: "unreachable", url, detail: "bound 3000 instead of $PORT" })).toContain(
      "The preview is unreachable: bound 3000 instead of $PORT;",
    );
  });
});

describe("standingContext", () => {
  test("nothing known is no paragraph at all", () => {
    expect(standingContext(null)).toBeUndefined();
    expect(standingContext({ main: false, base: "main" })).toBeUndefined();
  });
  test("a landed row names what landed, three subjects at most, and says nothing is left to commit or land", () => {
    expect(
      standingContext({
        main: false,
        base: "main",
        dirty: 0,
        ahead: 0,
        landed: { subjects: ["one", "two", "three", "four"], pr: 12 },
      }),
    ).toBe(
      'This worktree\'s work has landed on main as "one"; "two"; "three" (and 1 more), through PR #12. The branch restarted from main, so there is nothing here to commit or land until new work is written.',
    );
    // a landing with nothing to say, and no PR
    expect(standingContext({ main: false, base: "main", landed: { subjects: [] } })).toBe(
      "This worktree's work has landed on main. The branch restarted from main, so there is nothing here to commit or land until new work is written.",
    );
  });
  test("an unlanded row says what is uncommitted and how far the branch stands from its base", () => {
    expect(standingContext({ main: false, base: "main", dirty: 3, ahead: 2, behind: 4 })).toBe(
      "The tree has 3 uncommitted files, which the user commits from the commit box. The branch is 2 commits ahead of main and 4 behind it.",
    );
    expect(standingContext({ main: false, base: "main", dirty: 1, ahead: 1 })).toBe(
      "The tree has 1 uncommitted file, which the user commits from the commit box. The branch is 1 commit ahead of main.",
    );
    expect(standingContext({ main: false, base: "main", dirty: 0, ahead: 0, behind: 0 })).toBe(
      "The tree is clean. The branch is level with main.",
    );
    // a count not read is a clause left out, never a zero
    expect(standingContext({ main: false, base: "develop", dirty: 0 })).toBe("The tree is clean.");
    expect(standingContext({ main: false, base: "develop", ahead: 0, behind: 2 })).toBe(
      "The branch is 0 commits ahead of develop and 2 behind it.",
    );
  });
  test("an open PR is named with its address, checks, review, auto-merge and what it is missing", () => {
    expect(
      standingContext({
        main: false,
        base: "main",
        dirty: 0,
        ahead: 3,
        unpushed: 1,
        pr: { number: 7, url: "https://x/pull/7", state: "open", checks: "pass", review: "approved", automerge: true },
      }),
    ).toBe(
      "The tree is clean. The branch is 3 commits ahead of main. Pull request #7 is open at https://x/pull/7, checks passing, review approved, auto-merge on; 1 commit here is not on it yet.",
    );
    expect(
      standingContext({
        main: false,
        base: "main",
        unpushed: 2,
        pr: { number: 7, url: "https://x/pull/7", state: "open", checks: "fail", review: "changes_requested" },
      }),
    ).toBe(
      "Pull request #7 is open at https://x/pull/7, checks failing, review changes requested; 2 commits here are not on it yet.",
    );
  });
  test("a merged PR waits on the poll, a closed one on the next press, and a landed one is said once", () => {
    const pr = { number: 7, url: "https://x/pull/7" };
    expect(standingContext({ main: false, base: "main", dirty: 0, pr: { ...pr, state: "merged" } })).toBe(
      "The tree is clean. PR #7 has merged on GitHub; Toyon lands it here on its next poll.",
    );
    expect(standingContext({ main: false, base: "main", dirty: 0, pr: { ...pr, state: "closed" } })).toBe(
      "The tree is clean. PR #7 was closed without merging; the next land press creates a new one.",
    );
    expect(
      standingContext({
        main: false,
        base: "main",
        landed: { subjects: ["x"], pr: 7 },
        pr: { ...pr, state: "merged" },
      }),
    ).toBe(
      'This worktree\'s work has landed on main as "x", through PR #7. The branch restarted from main, so there is nothing here to commit or land until new work is written.',
    );
  });
  test("main says it is main, counts its tree, and trails origin rather than a base", () => {
    expect(standingContext({ main: true, base: "main", dirty: 2, behind: 3 })).toBe(
      "This is the project's main checkout. The tree has 2 uncommitted files. It is 3 commits behind origin.",
    );
    expect(standingContext({ main: true, base: "main", dirty: 0, behind: 0 })).toBe(
      "This is the project's main checkout. The tree is clean.",
    );
  });
});

describe("buildPrompt", () => {
  test("text only, context in its own block after it", () => {
    expect(buildPrompt("hi", "[ctx]")).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "[ctx]" },
    ]);
  });
  test("images lead, each behind its numbered caption; the prefix stays on the text block", () => {
    const blocks = buildPrompt("what is this", undefined, SYSTEM_APPEND, [image]);
    expect(blocks).toEqual([
      { type: "text", text: "Image 2: shot.png (10×5), saved at /store/wt/2.png" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "text", text: `${SYSTEM_APPEND}\n\nwhat is this` },
    ]);
  });

  test("a paste rides behind its caption, fenced so the model can see where it ends", () => {
    const blocks = buildPrompt("fix this", undefined, undefined, [
      { kind: "paste", ref: paste, text: "line one\nline two" },
    ]);
    expect(blocks).toEqual([
      {
        type: "text",
        text: "Pasted text 1 (2 lines, 17 chars), begins: line one\n<pasted-text 1>\nline one\nline two\n</pasted-text>",
      },
      { type: "text", text: "fix this" },
    ]);
  });

  test("attachments alone send without an empty text block; the prefix still rides", () => {
    const pasted = { kind: "paste" as const, ref: paste, text: "TypeError: x is undefined" };
    expect(heads(buildPrompt("", "[ctx]", undefined, [pasted]))).toEqual([
      "Pasted text 1 (2 lines, 17 chars), begins: line one",
      "[ctx]",
    ]);
    expect(buildPrompt("", undefined, SYSTEM_APPEND, [pasted]).at(-1)).toEqual({ type: "text", text: SYSTEM_APPEND });
  });

  test("attachments of every kind keep the order they were attached in", () => {
    const blocks = buildPrompt("do it", "[ctx]", undefined, [
      { kind: "pick", ref: pick },
      { kind: "paste", ref: paste, text: "a" },
      image,
    ]);
    expect(heads(blocks)).toEqual([
      `${picked} <Button /> used at src/pages/Home.tsx:40, its own JSX at src/ui/Button.tsx:12, text "Save"`,
      "Pasted text 1 (2 lines, 17 chars), begins: line one",
      "Image 2: shot.png (10×5), saved at /store/wt/2.png",
      "image",
      "do it",
      "[ctx]",
    ]);
  });

  test("a file goes as the path its copy is stored at, never as its bytes", () => {
    const blocks = buildPrompt("what failed", undefined, undefined, [
      { kind: "file", ref: file, path: "/store/wt/1-run.jsonl" },
    ]);
    expect(blocks).toEqual([
      {
        type: "text",
        text: "A file the user attached: run.jsonl (106 KB), saved at /store/wt/1-run.jsonl. Read or search it there.",
      },
      { type: "text", text: "what failed" },
    ]);
    expect(fileCaption({ ...file, bytes: 3 * 1024 * 1024 }, "/p")).toContain("(3.0 MB)");
  });

  test("a short file's text follows its caption, fenced, and the path is still named", () => {
    const ref = { ...file, name: "tsconfig.json", bytes: 16 };
    const blocks = buildPrompt("is this right", undefined, undefined, [
      { kind: "file", ref, path: "/store/wt/1-tsconfig.json", text: '{"strict":true}\n' },
    ]);
    expect(blocks[0]).toEqual({
      type: "text",
      text: 'A file the user attached: tsconfig.json (1 KB), saved at /store/wt/1-tsconfig.json.\n<attached-file 1>\n{"strict":true}\n\n</attached-file>',
    });
  });

  test("a paste from a file says so in the caption", () => {
    const blocks = buildPrompt("x", undefined, undefined, [
      { kind: "paste", ref: { ...paste, name: "App.tsx" }, text: "a" },
    ]);
    expect((blocks[0] as { text: string }).text).toStartWith("Pasted text 1 (App.tsx, 2 lines,");
  });

  test("a paste copied in the editor names its file and lines, and the commit when it is history", () => {
    const source = { path: "src/App.tsx", startLine: 12, endLine: 30 };
    expect(pasteCaption({ ...paste, source })).toBe("Pasted text 1 (copied from lines 12-30 of src/App.tsx)");
    expect(pasteCaption({ ...paste, source: { ...source, endLine: 12, ref: "3de79ed0aa" } })).toBe(
      "Pasted text 1 (copied from line 12 of src/App.tsx at commit 3de79ed)",
    );
  });
});

describe("pickCaption", () => {
  test("names the element, both files and which is which, then the markup on a line of its own", () => {
    expect(pickCaption(pick).split("\n")).toEqual([
      `${picked} <Button /> used at src/pages/Home.tsx:40, its own JSX at src/ui/Button.tsx:12, text "Save"`,
      "its HTML: <button>Save</button>",
    ]);
  });
  test("carries no number, since the chip shows none", () => {
    expect(pickCaption({ ...pick, n: 7 })).toBe(pickCaption(pick));
  });
  test("an element whose JSX is the file that renders it names one file", () => {
    expect(pickCaption({ ...pick, callFile: null, callLine: null })).toStartWith(
      `${picked} <Button /> defined at src/ui/Button.tsx:12,`,
    );
  });
  test("an element with no source and no text is its tag", () => {
    const bare = { ...pick, component: null, file: null, line: null, callFile: null, callLine: null, text: "" };
    expect(pickCaption(bare).split("\n")[0]).toBe(`${picked} <button>`);
  });
});

// An agent only dispatches a slash command when it leads the first text block, so a message that
// opens with one has to outrank the captions and the prefix that normally come first.
describe("buildPrompt with a leading slash command", () => {
  test("the command is block 0, ahead of image captions and the prefix", () => {
    const blocks = buildPrompt("/review the auth flow", "[ctx]", SYSTEM_APPEND, [image]);
    expect(blocks).toEqual([
      { type: "text", text: "/review the auth flow" },
      { type: "text", text: SYSTEM_APPEND },
      { type: "text", text: "Image 2: shot.png (10×5), saved at /store/wt/2.png" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
    ]);
  });

  // The Claude adapter runs `/usage` only when the prompt is that one text block, so a command sent
  // with nothing attached has to be exactly one block or it lands on the model as prose.
  test("a bare command goes alone: the ambient context is dropped, not appended", () => {
    expect(buildPrompt("/usage", "[Live preview context, current route: /]")).toEqual([
      { type: "text", text: "/usage" },
    ]);
  });

  test("a command with arguments loses the context too", () => {
    expect(buildPrompt("/code-review high", "[ctx]")).toEqual([{ type: "text", text: "/code-review high" }]);
  });

  test("text that only looks like a path keeps its context", () => {
    expect(buildPrompt("look at /Users/me/x", "[ctx]")).toHaveLength(2);
  });

  test("a Codex first prompt gets the prefix as its own block, never glued in front", () => {
    const blocks = buildPrompt("/ship", undefined, SYSTEM_APPEND);
    expect(blocks).toEqual([
      { type: "text", text: "/ship" },
      { type: "text", text: SYSTEM_APPEND },
    ]);
  });

  test("an mcp command reaches the agent verbatim, with nothing appended to its line", () => {
    const blocks = buildPrompt("/mcp:linear:issue 42", "[ctx]");
    expect(blocks).toEqual([{ type: "text", text: "/mcp:linear:issue 42" }]);
  });

  test("a bare slash or a path is not a command, so nothing is hoisted", () => {
    expect(buildPrompt("/ and then", "[ctx]")[0]).toEqual({ type: "text", text: "/ and then" });
    expect(buildPrompt("look at /Users/me/x", "[ctx]")[0]).toEqual({ type: "text", text: "look at /Users/me/x" });
  });
});

describe("procFixPrompt", () => {
  test("names the bad procs with their command, port and diagnosis, and the output tail", () => {
    const text = procFixPrompt(
      [
        {
          name: "web",
          command: "npm run dev",
          port: 4523,
          status: "unreachable",
          detail: "nothing listening on :4523",
        },
        { name: "api", command: "bun api", port: 4524, status: "running" },
      ],
      [
        { proc: "web", line: "VITE ready" },
        { proc: "web", line: "Local: http://localhost:5173/" },
      ],
    );
    expect(text).toContain("`web`: `npm run dev`, started with PORT=4523. nothing listening on :4523");
    expect(text).not.toContain("`api`");
    expect(text).toContain("[web] Local: http://localhost:5173/");
    expect(text).toContain("PORT environment variable");
  });
  test("a crash without a diagnosis says the exit code; no output says so", () => {
    const text = procFixPrompt([{ name: "web", command: "x", port: 1, status: "crashed", exitCode: 2 }], []);
    expect(text).toContain("exited with code 2");
    expect(text).toContain("It produced no output.");
  });
});
