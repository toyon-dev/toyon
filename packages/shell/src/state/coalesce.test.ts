import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import { coalesceDeltas, STREAM_TICK_MS } from "./coalesce.ts";
import type { StoreServerMsg } from "./store.ts";

const agent = (seq: number, event: AgentEvent, worktreeId = "wt"): StoreServerMsg => ({
  t: "agent",
  worktreeId,
  seq,
  event,
});
const text = (seq: number, text: string, messageId?: string, worktreeId?: string) =>
  agent(seq, messageId ? { type: "text-delta", text, messageId } : { type: "text-delta", text }, worktreeId);
const tool = (seq: number, toolId: string, text: string) => agent(seq, { type: "tool-delta", toolId, text });
const think = (seq: number, text: string) => agent(seq, { type: "thinking-delta", text });
const turnEnd = (seq: number): StoreServerMsg => agent(seq, { type: "turn-end", stopReason: "end_turn", ts: seq });

/** the coalescer on a clock a test moves by hand; `tick()` runs the timer it set, if one is due */
function harness() {
  const out: StoreServerMsg[] = [];
  let clock = 1000;
  const timers: Array<{ at: number; run: () => void }> = [];
  const push = coalesceDeltas((m) => out.push(m), {
    now: () => clock,
    after: (ms, run) => void timers.push({ at: clock + ms, run }),
  });
  const advance = (ms: number) => {
    clock += ms;
    while (timers.length && timers[0]!.at <= clock) timers.shift()!.run();
  };
  return { out, push, advance, timers: () => timers.length };
}

const eventsOf = (out: StoreServerMsg[]) => out.map((m) => (m.t === "agent" ? m.event : m.t));

describe("coalesceDeltas", () => {
  test("the first chunk of a reply goes at once", () => {
    const h = harness();
    h.push(text(1, "The "));
    expect(h.out).toEqual([text(1, "The ")]);
    expect(h.timers()).toBe(0);
  });

  test("chunks inside the tick are held and land together, under the first one's seq", () => {
    const h = harness();
    h.push(text(1, "The "));
    h.advance(10);
    h.push(text(2, "fan "));
    h.push(text(3, "is "));
    h.advance(50);
    h.push(text(4, "going"));
    expect(h.out).toHaveLength(1);
    h.advance(STREAM_TICK_MS - 60);
    expect(h.out).toEqual([text(1, "The "), text(2, "fan is going")]);
  });

  test("the tick is counted from the last delivery, so a stream lands on a steady beat", () => {
    const h = harness();
    h.push(text(1, "a"));
    h.advance(STREAM_TICK_MS - 1);
    h.push(text(2, "b"));
    expect(h.out).toHaveLength(1);
    h.advance(1);
    expect(h.out).toHaveLength(2);
    h.push(text(3, "c"));
    expect(h.out).toHaveLength(2);
    h.advance(STREAM_TICK_MS);
    expect(eventsOf(h.out)).toEqual([
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "b" },
      { type: "text-delta", text: "c" },
    ]);
  });

  test("after a quiet tick the next chunk goes at once again", () => {
    const h = harness();
    h.push(text(1, "a"));
    h.advance(STREAM_TICK_MS * 3);
    h.push(text(2, "b"));
    expect(h.out).toEqual([text(1, "a"), text(2, "b")]);
  });

  test("a message that is not a delta flushes what is held ahead of itself, at once", () => {
    const h = harness();
    h.push(text(1, "a"));
    h.push(text(2, "b"));
    h.push(text(3, "c"));
    h.push(turnEnd(4));
    expect(h.out).toEqual([text(1, "a"), text(2, "bc"), turnEnd(4)]);
    // the timer that was set finds nothing left to land
    h.advance(STREAM_TICK_MS);
    expect(h.out).toHaveLength(3);
  });

  test("runs of different streams stay apart and in order", () => {
    const h = harness();
    h.push(text(1, "a"));
    h.push(text(2, "b"));
    h.push(tool(3, "t1", "x"));
    h.push(tool(4, "t1", "y"));
    h.push(tool(5, "t2", "z"));
    h.push(text(6, "c"));
    h.advance(STREAM_TICK_MS);
    expect(eventsOf(h.out)).toEqual([
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "b" },
      { type: "tool-delta", toolId: "t1", text: "xy" },
      { type: "tool-delta", toolId: "t2", text: "z" },
      { type: "text-delta", text: "c" },
    ]);
  });

  test("text for another message, or another worktree, starts its own run", () => {
    const h = harness();
    h.push(think(1, "hm"));
    h.push(text(2, "a", "m1"));
    h.push(text(3, "b", "m1"));
    h.push(text(4, "c", "m2"));
    h.push(text(5, "d", "m2", "other"));
    h.advance(STREAM_TICK_MS);
    expect(h.out).toEqual([think(1, "hm"), text(2, "ab", "m1"), text(4, "c", "m2"), text(5, "d", "m2", "other")]);
  });

  test("with nothing held a message passes straight through, and no timer is set", () => {
    const h = harness();
    h.push(turnEnd(1));
    expect(h.out).toEqual([turnEnd(1)]);
    expect(h.timers()).toBe(0);
  });

  test("the chunks handed on are not the ones handed in", () => {
    const h = harness();
    h.push(text(1, "a"));
    const second = text(2, "b");
    h.push(second);
    h.push(text(3, "c"));
    h.advance(STREAM_TICK_MS);
    expect(second).toEqual(text(2, "b"));
    expect(h.out[1]).toEqual(text(2, "bc"));
  });
});
