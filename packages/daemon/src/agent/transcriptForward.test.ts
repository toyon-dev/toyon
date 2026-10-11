import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardLine, forwardText, forwardTranscripts } from "./transcriptForward.ts";

/** one row as 0.12.0 wrote it: a single throw under `message` */
const OLD =
  '{"seq":349,"event":{"type":"page-error","message":"Uncaught ReferenceError: refusal is not defined (src/a.tsx:129)","ts":1791711605866}}';
const NEW = '{"seq":350,"event":{"type":"page-error","errors":["boom (src/b.tsx:4)"],"ts":2}}';
const OTHER = '{"seq":351,"event":{"type":"user-message","text":"page-error is a word here","ts":3}}';

describe("forwardLine", () => {
  test("a 0.12.0 row becomes the list shape, keeping its seq and ts and dropping message", () => {
    const next = forwardLine(OLD);
    expect(next).not.toBeNull();
    expect(JSON.parse(next as string)).toEqual({
      seq: 349,
      event: {
        type: "page-error",
        errors: ["Uncaught ReferenceError: refusal is not defined (src/a.tsx:129)"],
        ts: 1791711605866,
      },
    });
  });

  test("a current row, another type naming the word, and a torn line are left alone", () => {
    expect(forwardLine(NEW)).toBeNull();
    expect(forwardLine(OTHER)).toBeNull();
    expect(forwardLine(OLD.slice(0, 40))).toBeNull();
    expect(forwardLine("")).toBeNull();
  });
});

describe("forwardText", () => {
  test("rewrites only the old rows, counts them, and keeps the trailing newline", () => {
    const { text, changed } = forwardText(`${OTHER}\n${OLD}\n${NEW}\n${OLD}\n`);
    expect(changed).toBe(2);
    const lines = text.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(OTHER);
    expect(lines[2]).toBe(NEW);
    expect(lines[4]).toBe("");
    expect(JSON.parse(lines[1] as string).event.errors).toHaveLength(1);
    expect(JSON.parse(lines[3] as string).event.message).toBeUndefined();
  });

  test("a text with nothing to move comes back as the same string", () => {
    const text = `${OTHER}\n${NEW}\n`;
    expect(forwardText(text)).toEqual({ text, changed: 0 });
  });
});

describe("forwardTranscripts", () => {
  test("rewrites the files that need it in place and leaves the rest untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-forward-"));
    try {
      writeFileSync(join(dir, "a.jsonl"), `${OTHER}\n${OLD}\n`);
      writeFileSync(join(dir, "b.jsonl"), `${NEW}\n`);
      writeFileSync(join(dir, "notes.txt"), `${OLD}\n`);
      forwardTranscripts(dir);
      const a = readFileSync(join(dir, "a.jsonl"), "utf8").split("\n");
      expect(a[0]).toBe(OTHER);
      expect(JSON.parse(a[1] as string).event).toEqual({
        type: "page-error",
        errors: ["Uncaught ReferenceError: refusal is not defined (src/a.tsx:129)"],
        ts: 1791711605866,
      });
      expect(readFileSync(join(dir, "b.jsonl"), "utf8")).toBe(`${NEW}\n`);
      expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe(`${OLD}\n`);
      // a second boot finds nothing to move
      forwardTranscripts(dir);
      expect(readFileSync(join(dir, "a.jsonl"), "utf8")).toBe(`${a[0]}\n${a[1]}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
