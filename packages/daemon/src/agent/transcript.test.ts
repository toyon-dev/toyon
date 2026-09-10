import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_ENTRIES, MAX_ENTRIES, Transcript, transcriptPathFor } from "./transcript.ts";

function withDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "toyon-transcript-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** n turns of `perTurn` entries each: a turn-start, then deltas */
function turns(n: number, perTurn: number): string {
  let seq = 0;
  const lines: string[] = [];
  for (let t = 0; t < n; t++) {
    lines.push(JSON.stringify({ seq: seq++, event: { type: "turn-start", ts: t } }));
    for (let i = 1; i < perTurn; i++) {
      lines.push(JSON.stringify({ seq: seq++, event: { type: "text-delta", text: "x" } }));
    }
  }
  return `${lines.join("\n")}\n`;
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

  test("a file past the cap is cut to the newest turns at load, on a turn boundary, seqs continuing", () =>
    withDir((dir) => {
      const p = transcriptPathFor(dir, "w3");
      const perTurn = 10;
      const total = MAX_ENTRIES + 500;
      writeFileSync(p, turns(total / perTurn, perTurn));
      const t = new Transcript(p, "w3");
      expect(t.entries.length).toBeLessThanOrEqual(KEEP_ENTRIES);
      expect(t.entries.length).toBeGreaterThan(KEEP_ENTRIES - perTurn);
      expect(t.entries[0]!.event.type).toBe("turn-start");
      // the file was rewritten to match
      expect(readFileSync(p, "utf8").trim().split("\n").length).toBe(t.entries.length);
      expect(t.append({ type: "turn-end", stopReason: "end_turn", ts: 9 }).seq).toBe(total);
    }));

  test("appending past the cap compacts in memory and, in order with the appends, on disk", () =>
    withDir(async (dir) => {
      const p = transcriptPathFor(dir, "w4");
      const t = new Transcript(p, "w4");
      for (let i = 0; i <= MAX_ENTRIES; i++) {
        t.append(i % 10 === 0 ? { type: "turn-start", ts: i } : { type: "text-delta", text: "x" });
      }
      // one past the cap: cut back to the tail, the array the session holds included
      const held = t.entries;
      expect(held.length).toBeLessThanOrEqual(KEEP_ENTRIES);
      expect(held[0]!.event.type).toBe("turn-start");
      const after = t.append({ type: "text-delta", text: "after" });
      expect(after.seq).toBe(MAX_ENTRIES + 1);
      await t.flush();
      const lines = readFileSync(p, "utf8").trim().split("\n");
      expect(lines.length).toBe(held.length);
      expect(JSON.parse(lines.at(-1)!).seq).toBe(after.seq);
      expect(JSON.parse(lines[0]!).seq).toBe(held[0]!.seq);
    }));
});
