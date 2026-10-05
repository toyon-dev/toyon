import { describe, expect, test } from "bun:test";
import { PASTE_MIN_CHARS, PASTE_MIN_LINES } from "@toyon/shared";
import { copiedOf } from "./clipboardOffer.ts";

const png = (size: number) => ({ type: "image/png", size }) as Blob;

describe("what a read of the clipboard is worth offering", () => {
  test("a picture wins over the text flavour beside it, as it does in a paste", () => {
    expect(copiedOf({ image: png(10), text: "x".repeat(PASTE_MIN_CHARS) })?.kind).toBe("image");
  });

  test("text is offered only when a paste would make a chip of it", () => {
    expect(copiedOf({ text: "src/App.tsx" })).toBeNull();
    expect(copiedOf({ text: "hunter2" })).toBeNull();
    expect(copiedOf({ text: "l\n".repeat(PASTE_MIN_LINES) })?.kind).toBe("text");
  });

  test("an empty clipboard offers nothing", () => {
    expect(copiedOf({})).toBeNull();
    expect(copiedOf({ text: "" })).toBeNull();
  });

  test("the same copy reads as the same thing, and another as another", () => {
    expect(copiedOf({ image: png(10) })?.sig).toBe(copiedOf({ image: png(10) })?.sig);
    expect(copiedOf({ image: png(10) })?.sig).not.toBe(copiedOf({ image: png(11) })?.sig);
  });
});
