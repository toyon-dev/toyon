import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript, transcriptPathFor } from "./transcript.ts";

function withDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "toyon-transcript-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("Transcript", () => {
  test("appends land in order and are readable back with continuing seqs", () =>
    withDir(async (dir) => {
      const p = transcriptPathFor(dir, "w1");
      const t = new Transcript(p, "w1");
      expect(t.append({ type: "turn-start", ts: 1 }).seq).toBe(0);
      expect(t.append({ type: "text-delta", text: "hi" }).seq).toBe(1);
      await t.flush();
      const lines = readFileSync(p, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const again = new Transcript(p, "w1");
      expect(again.entries.map((e) => e.seq)).toEqual([0, 1]);
      expect(again.append({ type: "turn-end", stopReason: "end_turn", ts: 2 }).seq).toBe(2);
    }));

  test("a torn last line is skipped, not fatal", () =>
    withDir((dir) => {
      const p = transcriptPathFor(dir, "w2");
      writeFileSync(p, `${JSON.stringify({ seq: 0, event: { type: "turn-start", ts: 1 } })}\n{"seq":1,"eve`);
      const t = new Transcript(p, "w2");
      expect(t.entries).toHaveLength(1);
      expect(t.append({ type: "turn-start", ts: 3 }).seq).toBe(1);
    }));
});
