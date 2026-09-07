import { describe, expect, test } from "bun:test";
import { buildPrompt, SYSTEM_APPEND } from "./prompt.ts";

const ref = { n: 2, name: "shot.png", mimeType: "image/png", bytes: 3, width: 10, height: 5, file: "2.png" };

describe("buildPrompt", () => {
  test("text only, context after the text", () => {
    expect(buildPrompt("hi", "[ctx]")).toEqual([{ type: "text", text: "hi\n\n[ctx]" }]);
  });
  test("images lead, each behind its numbered caption; the prefix stays on the text block", () => {
    const blocks = buildPrompt("what is this", undefined, SYSTEM_APPEND, [{ ref, bytes: Buffer.from("abc") }]);
    expect(blocks).toEqual([
      { type: "text", text: "Image 2: shot.png (10×5)" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "text", text: `${SYSTEM_APPEND}\n\nwhat is this` },
    ]);
  });
});
