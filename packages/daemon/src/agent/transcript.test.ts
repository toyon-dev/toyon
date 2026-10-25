import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@toyon/shared";
import { after, lastSeq, sealOpenTurn, Transcript, type TranscriptEntry, transcriptPathFor } from "./transcript.ts";

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

describe("sealOpenTurn", () => {
  const log = (...events: AgentEvent[]): TranscriptEntry[] => events.map((event, seq) => ({ seq, event }));
  const start: AgentEvent = { type: "turn-start", ts: 2 };
  const call: AgentEvent = { type: "tool-start", toolId: "t1", name: "Bash", input: {} };
  const error: AgentEvent = { type: "agent-error", message: "API Error: ENOTFOUND", ts: 3 };
  const card: AgentEvent = { type: "agent-auth-required", agent: "claude", agentName: "Claude", methods: [], ts: 3 };
  const usage: AgentEvent = { type: "usage", used: 1, size: 2, ts: 4 };

  test("a turn that ended on an error row, or on a card, is sealed with that as the reason", () => {
    expect(sealOpenTurn(log(start, call, error, usage))).toEqual({ type: "turn-end", stopReason: "failed", ts: 4 });
    expect(sealOpenTurn(log(start, call, card))).toEqual({ type: "turn-end", stopReason: "auth", ts: 3 });
  });

  test("a turn cut with no last word, or one that went on after an error row, was lost with its daemon", () => {
    expect(sealOpenTurn(log(start, call))).toEqual({ type: "turn-end", stopReason: "lost", ts: 2 });
    expect(sealOpenTurn(log(start, error, call))).toEqual({ type: "turn-end", stopReason: "lost", ts: 3 });
  });

  test("a message queued behind the failure, by a person or a fix press, is not the turn's last word", () => {
    const press: AgentEvent = { type: "fix-asked", text: "fix it", ts: 5, kind: "command", why: "the command failed" };
    const sent: AgentEvent = { type: "user-message", text: "try again", ts: 6 };
    expect(sealOpenTurn(log(start, call, error, press, sent))).toEqual({
      type: "turn-end",
      stopReason: "failed",
      ts: 6,
    });
  });

  test("a closed last turn, and no turn at all, are owed nothing", () => {
    const end: AgentEvent = { type: "turn-end", stopReason: "end_turn", ts: 5 };
    expect(sealOpenTurn(log(start, call, error, end, usage))).toBeNull();
    expect(sealOpenTurn(log({ type: "user-message", text: "hi", ts: 1 }))).toBeNull();
    expect(sealOpenTurn([])).toBeNull();
  });
});

describe("the tail after a seq", () => {
  const at = (seq: number): TranscriptEntry => ({ seq, event: { type: "turn-start", ts: seq } });
  // a torn line dropped at parse leaves a gap: 0, 1, 2, 5, 6
  const entries = [at(0), at(1), at(2), at(5), at(6)];

  test("what follows the seq, found by search, a gap included", () => {
    expect(after(entries, 1).map((e) => e.seq)).toEqual([2, 5, 6]);
    expect(after(entries, 2).map((e) => e.seq)).toEqual([5, 6]);
    expect(after(entries, 3).map((e) => e.seq)).toEqual([5, 6]);
    expect(after(entries, 5).map((e) => e.seq)).toEqual([6]);
  });
  test("below the first is everything; at or past the last is nothing", () => {
    expect(after(entries, -1)).toEqual(entries);
    expect(after(entries, 6)).toEqual([]);
    expect(after(entries, 9)).toEqual([]);
    expect(after([], 0)).toEqual([]);
  });
  test("the last seq, -1 for none", () => {
    expect(lastSeq(entries)).toBe(6);
    expect(lastSeq([])).toBe(-1);
  });
});
