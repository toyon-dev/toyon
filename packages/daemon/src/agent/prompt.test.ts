import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { buildPrompt, pasteCaption, pickCaption, SYSTEM_APPEND } from "./prompt.ts";

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
/** each block's first line, or its type when it is not text */
const heads = (blocks: ContentBlock[]) => blocks.map((b) => (b.type === "text" ? b.text.split("\n")[0] : b.type));

describe("SYSTEM_APPEND", () => {
  test("tells the agent what makes a project runnable here", () => {
    expect(SYSTEM_APPEND).toContain("toyon.json");
    expect(SYSTEM_APPEND).toContain("$PORT");
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
    const blocks = buildPrompt("what is this", undefined, SYSTEM_APPEND, [{ ref, bytes: Buffer.from("abc") }]);
    expect(blocks).toEqual([
      { type: "text", text: "Image 2: shot.png (10×5)" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "text", text: `${SYSTEM_APPEND}\n\nwhat is this` },
    ]);
  });

  test("a paste rides behind its caption, fenced so the model can see where it ends", () => {
    const blocks = buildPrompt("fix this", undefined, undefined, [{ ref: paste, text: "line one\nline two" }]);
    expect(blocks).toEqual([
      {
        type: "text",
        text: "Pasted text 1 (2 lines, 17 chars), begins: line one\n<pasted-text 1>\nline one\nline two\n</pasted-text>",
      },
      { type: "text", text: "fix this" },
    ]);
  });

  test("attachments of every kind keep the order they were attached in", () => {
    const blocks = buildPrompt("do it", "[ctx]", undefined, [
      { ref: pick },
      { ref: paste, text: "a" },
      { ref, bytes: Buffer.from("abc") },
    ]);
    expect(heads(blocks)).toEqual([
      'Element 1 (an element the user picked in the preview): <Button> component used at src/pages/Home.tsx:40, its own JSX at src/ui/Button.tsx:12, text "Save"',
      "Pasted text 1 (2 lines, 17 chars), begins: line one",
      "Image 2: shot.png (10×5)",
      "image",
      "do it",
      "[ctx]",
    ]);
  });

  test("a paste from a file says so in the caption", () => {
    const blocks = buildPrompt("x", undefined, undefined, [{ ref: { ...paste, name: "App.tsx" }, text: "a" }]);
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
  test("names both files and which is which, then the markup on a line of its own", () => {
    expect(pickCaption(pick).split("\n")).toEqual([
      'Element 1 (an element the user picked in the preview): <Button> component used at src/pages/Home.tsx:40, its own JSX at src/ui/Button.tsx:12, text "Save"',
      "its HTML: <button>Save</button>",
    ]);
  });
  test("an element whose JSX is the file that renders it names one file", () => {
    expect(pickCaption({ ...pick, callFile: null, callLine: null })).toStartWith(
      "Element 1 (an element the user picked in the preview): <Button> component defined at src/ui/Button.tsx:12,",
    );
  });
  test("an element with no source and no text is its tag", () => {
    const bare = { ...pick, component: null, file: null, line: null, callFile: null, callLine: null, text: "" };
    expect(pickCaption(bare).split("\n")[0]).toBe("Element 1 (an element the user picked in the preview): <button>");
  });
});

// An agent only dispatches a slash command when it leads the first text block, so a message that
// opens with one has to outrank the captions and the prefix that normally come first.
describe("buildPrompt with a leading slash command", () => {
  test("the command is block 0, ahead of image captions and the prefix", () => {
    const blocks = buildPrompt("/review the auth flow", "[ctx]", SYSTEM_APPEND, [{ ref, bytes: Buffer.from("abc") }]);
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
