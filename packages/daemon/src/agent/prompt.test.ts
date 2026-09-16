import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { attached, buildPrompt, pasteCaption, pickCaption, previewContext, SYSTEM_APPEND } from "./prompt.ts";

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
const image = { kind: "image" as const, ref, bytes: Buffer.from("abc") };
const picked = "An element the user picked in the preview:";
/** each block's first line, or its type when it is not text */
const heads = (blocks: ContentBlock[]) => blocks.map((b) => (b.type === "text" ? b.text.split("\n")[0] : b.type));

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
});

describe("attached", () => {
  test("one block with one opening around whatever there is to say, and nothing around nothing", () => {
    expect(attached([])).toBeUndefined();
    expect(attached([undefined])).toBeUndefined();
    expect(attached(["the page", undefined, "the preview"])).toBe(
      "[Attached by Toyon, not written by the user:\nthe page\n\nthe preview]",
    );
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
      { type: "text", text: "Image 2: shot.png (10×5)" },
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
      "Image 2: shot.png (10×5)",
      "image",
      "do it",
      "[ctx]",
    ]);
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
      { type: "text", text: "Image 2: shot.png (10×5)" },
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
