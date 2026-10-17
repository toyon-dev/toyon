import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORWARD_STEP, forwardLine, forwardText, forwardTranscripts } from "./transcriptForward.ts";

/** the row 0.12.0 to 0.15.0 wrote for what the preview threw */
const ROW = '{"seq":350,"event":{"type":"page-error","errors":["boom (src/b.tsx:4)"],"ts":2}}';
/** the message its press sent */
const PRESS =
  '{"seq":351,"event":{"type":"fix-asked","text":"Since your last edits the preview threw this","ts":3,"kind":"page","why":"the preview threw"}}';
/** the same message as it reads now: an ask of the one kind a press still makes */
const PRESSED =
  '{"seq":351,"event":{"type":"fix-asked","text":"Since your last edits the preview threw this","ts":3,"kind":"command","why":"the preview threw"}}';
const OTHER = '{"seq":352,"event":{"type":"user-message","text":"page-error is a word here","ts":4}}';
const ASK = '{"seq":353,"event":{"type":"fix-asked","text":"fix it","ts":5,"kind":"check","why":"the check failed"}}';

describe("forwardLine", () => {
  test("the page row goes, its press keeps its words under a kind that still exists, the rest stay", () => {
    expect(forwardLine(ROW)).toEqual({ drop: true });
    expect(forwardLine(PRESS)).toEqual({ line: PRESSED });
    expect(forwardLine(OTHER)).toBeNull();
    expect(forwardLine(ASK)).toBeNull();
    expect(forwardLine(ROW.slice(0, 40))).toBeNull();
    expect(forwardLine("")).toBeNull();
  });
});

describe("forwardText", () => {
  test("moves only the old rows, counts them, and keeps the trailing newline", () => {
    const { text, changed } = forwardText(`${OTHER}\n${ROW}\n${ASK}\n${PRESS}\n`);
    expect(changed).toBe(2);
    expect(text).toBe(`${OTHER}\n${ASK}\n${PRESSED}\n`);
  });

  test("a text with nothing to move comes back as the same string", () => {
    const text = `${OTHER}\n${ASK}\n`;
    expect(forwardText(text)).toEqual({ text, changed: 0 });
  });
});

describe("forwardTranscripts", () => {
  test("rewrites the live files and the archives that need it in place, once, and leaves the rest untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-forward-"));
    try {
      const live = join(dir, "transcripts");
      const archive = join(dir, "archive");
      const stamp = join(dir, "stamp");
      mkdirSync(live);
      mkdirSync(archive);
      writeFileSync(join(live, "a.jsonl"), `${OTHER}\n${ROW}\n`);
      writeFileSync(join(live, "b.jsonl"), `${ASK}\n`);
      writeFileSync(join(live, "notes.txt"), `${ROW}\n`);
      mkdirSync(join(archive, "arch1"));
      writeFileSync(join(archive, "arch1", "transcript.jsonl"), `${PRESS}\n${OTHER}\n`);
      mkdirSync(join(archive, "plain"));
      forwardTranscripts([live, archive], stamp);
      expect(readFileSync(join(live, "a.jsonl"), "utf8")).toBe(`${OTHER}\n`);
      expect(readFileSync(join(live, "b.jsonl"), "utf8")).toBe(`${ASK}\n`);
      expect(readFileSync(join(live, "notes.txt"), "utf8")).toBe(`${ROW}\n`);
      expect(readFileSync(join(archive, "arch1", "transcript.jsonl"), "utf8")).toBe(`${PRESSED}\n${OTHER}\n`);
      expect(readFileSync(stamp, "utf8")).toBe(FORWARD_STEP);
      // the next boot is stamped: the files are not read, so a row written since is not touched
      writeFileSync(join(live, "c.jsonl"), `${ROW}\n`);
      forwardTranscripts([live, archive], stamp);
      expect(readFileSync(join(live, "c.jsonl"), "utf8")).toBe(`${ROW}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
