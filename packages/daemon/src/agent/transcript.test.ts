import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coalesce, Transcript, transcriptPathFor } from "./transcript.ts";

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

describe("coalesce", () => {
  test("adjacent deltas of one kind fold into one entry with the run's first seq; anything between breaks the run", () => {
    const entries = [
      { seq: 0, event: { type: "user-message", text: "go", ts: 1 } },
      { seq: 1, event: { type: "thinking-delta", text: "a" } },
      { seq: 2, event: { type: "thinking-delta", text: "b" } },
      { seq: 3, event: { type: "text-delta", text: "he" } },
      { seq: 4, event: { type: "text-delta", text: "llo" } },
      { seq: 5, event: { type: "turn-end", stopReason: "end_turn", ts: 2 } },
      { seq: 6, event: { type: "text-delta", text: "!" } },
    ] as const;
    expect(coalesce([...entries])).toEqual([
      entries[0],
      { seq: 1, event: { type: "thinking-delta", text: "ab" } },
      { seq: 3, event: { type: "text-delta", text: "hello" } },
      entries[5],
      entries[6],
    ]);
  });

  test("a watched command's output chunks fold under their row; another row's chunk breaks the run", () => {
    const entries = [
      { seq: 0, event: { type: "tool-start", toolId: "a", name: "shell", input: { command: "git push" } } },
      { seq: 1, event: { type: "tool-delta", toolId: "a", text: "tests " } },
      { seq: 2, event: { type: "tool-delta", toolId: "a", text: "1/2\n" } },
      { seq: 3, event: { type: "tool-delta", toolId: "b", text: "other" } },
      { seq: 4, event: { type: "tool-delta", toolId: "a", text: "2/2\n" } },
    ] as const;
    expect(coalesce([...entries])).toEqual([
      entries[0],
      { seq: 1, event: { type: "tool-delta", toolId: "a", text: "tests 1/2\n" } },
      entries[3],
      entries[4],
    ]);
  });
});

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

  test("a long session is kept whole: the first turn is still there after a reload and more appends", () =>
    withDir(async (dir) => {
      const p = transcriptPathFor(dir, "w3");
      const total = 20_000;
      writeFileSync(p, turns(total / 10, 10));
      const t = new Transcript(p, "w3");
      expect(t.entries.length).toBe(total);
      expect(t.entries[0]).toEqual({ seq: 0, event: { type: "turn-start", ts: 0 } });
      // nothing rewritten at load
      expect(readFileSync(p, "utf8").trim().split("\n").length).toBe(total);
      const after = t.append({ type: "turn-end", stopReason: "end_turn", ts: 9 });
      expect(after.seq).toBe(total);
      await t.flush();
      const lines = readFileSync(p, "utf8").trim().split("\n");
      expect(lines.length).toBe(total + 1);
      expect(JSON.parse(lines[0]!).seq).toBe(0);
      expect(JSON.parse(lines.at(-1)!).seq).toBe(after.seq);
    }));
});
