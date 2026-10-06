import type { AgentEvent } from "@toyon/shared";
import type { StoreServerMsg } from "./store.ts";

/**
 * Streamed text reaches the store at the pace it can be read, not at the pace it arrives.
 *
 * An agent's reply comes as a dense run of small chunks, and every one that reaches the store
 * is a render of the whole log, which a long transcript makes expensive. Nothing is read faster
 * than ten times a second, and a row's markdown already repaints no faster than that
 * (useMarkdown), so chunks are handed on at that cadence: the first of a run at once, so the
 * reply starts the moment it starts, and the rest merged and delivered one tick after the last
 * delivery. Only the three delta kinds are held, and only consecutive ones of the same stream
 * merge; anything else flushes what is held ahead of itself, so the store sees the daemon's
 * order, and a tool's start or a turn's end lands with no added wait.
 */

/** how often text that is still arriving changes on screen, in ms */
export const STREAM_TICK_MS = 100;

type AgentMsg = Extract<StoreServerMsg, { t: "agent" }>;
type Delta = Extract<AgentEvent, { type: "text-delta" | "thinking-delta" | "tool-delta" }>;
type HeldMsg = AgentMsg & { event: Delta };

const isDelta = (e: AgentEvent): e is Delta =>
  e.type === "text-delta" || e.type === "thinking-delta" || e.type === "tool-delta";

/** whether `b` continues `a`: the same kind of text, of the same stream, in the same worktree */
function sameRun(a: HeldMsg, b: HeldMsg): boolean {
  if (a.worktreeId !== b.worktreeId || a.event.type !== b.event.type) return false;
  switch (a.event.type) {
    case "text-delta":
      return a.event.messageId === (b.event as Extract<Delta, { type: "text-delta" }>).messageId;
    case "tool-delta":
      return a.event.toolId === (b.event as Extract<Delta, { type: "tool-delta" }>).toolId;
    default:
      return true;
  }
}

/** the clock and the timer, the browser's unless a test brings its own */
export interface Timing {
  now: () => number;
  after: (ms: number, run: () => void) => void;
}

const browserTiming: Timing = {
  now: () => performance.now(),
  after: (ms, run) => void setTimeout(run, ms),
};

/** `deliver` wrapped so that streamed chunks reach it on the tick, merged by stream */
export function coalesceDeltas(
  deliver: (msg: StoreServerMsg) => void,
  timing: Timing = browserTiming,
): (msg: StoreServerMsg) => void {
  let held: HeldMsg[] = [];
  let armed = false;
  // when text last reached the store: the next run may go at once a tick after this
  let deliveredAt = Number.NEGATIVE_INFINITY;
  const flush = () => {
    armed = false;
    if (held.length === 0) return;
    const out = held;
    held = [];
    deliveredAt = timing.now();
    for (const m of out) deliver(m);
  };
  return (msg) => {
    if (msg.t === "agent" && isDelta(msg.event)) {
      const next = { ...msg, event: { ...msg.event } } as HeldMsg;
      const now = timing.now();
      if (held.length === 0 && now - deliveredAt >= STREAM_TICK_MS) {
        deliveredAt = now;
        deliver(next);
        return;
      }
      const last = held[held.length - 1];
      // a run keeps its first chunk's seq, which is the one the store stamps a row with anyway
      if (last && sameRun(last, next)) last.event = { ...last.event, text: last.event.text + next.event.text };
      else held.push(next);
      if (!armed) {
        armed = true;
        timing.after(Math.max(0, deliveredAt + STREAM_TICK_MS - now), flush);
      }
      return;
    }
    flush();
    deliver(msg);
  };
}
