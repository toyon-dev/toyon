// A wakeup the agent booked for itself: Claude Code's ScheduleWakeup, the self-paced loop, where
// the call returns at once with the delay taken, the turn ends, and the agent is back when the
// timer fires, in a turn of its own. On the wire that is a call that opened and closed in a
// second and then silence: nothing in the transcript or on the rail said the agent was due back,
// or when. This keeps the row open until it is: the turn the agent starts on its own ends it, and
// so does the agent ending the loop or booking again, and a deadline a grace past the booked time
// ends it when no turn came, so a row never waits for good on a wakeup that was lost with the
// process. A message sent meanwhile is not an end: the runtime fires the wakeup after that turn
// all the same (measured against the real adapter), so the row waits on through it.

import type { AgentEvent } from "@toyon/shared";

export const WAKEUP_TOOL = "ScheduleWakeup";

/** the runtime clamps the delay to this range, whatever the agent asked for */
const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
/** How long past the booked time the row waits for the turn before it stops. The runtime is
 * late by up to a minute on a quiet session (a sixty-second booking came back after a hundred
 * and thirteen), so a minute's grace closed the row seconds before the agent returned. */
const GRACE_MS = 3 * 60_000;

function record(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : null;
}

/** the time the call books the agent to be back, or null: not a wakeup, one ending the loop
 * (`stop`), or a delay the runtime would refuse */
export function wakeupAt(name: string, input: unknown, now = Date.now()): number | null {
  if (name !== WAKEUP_TOOL) return null;
  const rec = record(input);
  if (!rec || rec.stop === true) return null;
  const delay = rec.delaySeconds;
  if (typeof delay !== "number" || !Number.isFinite(delay)) return null;
  return now + Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, delay)) * 1000;
}

/** the call ends the loop: no wakeup is coming for the booking before it */
export function loopEnds(name: string, input: unknown): boolean {
  return name === WAKEUP_TOOL && record(input)?.stop === true;
}

export interface WakeupDeps {
  note: (event: AgentEvent) => void;
  /** a row opened or closed: the count the rail reads moved, and the session may have nothing
   * left to hold its process for */
  onChange?: () => void;
  graceMs?: number;
}

export class Wakeups {
  private held = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private deps: WakeupDeps) {}

  get size(): number {
    return this.held.size;
  }

  /** the earliest booked time among the rows open, or null */
  get next(): number | null {
    let next: number | null = null;
    for (const w of this.held.values()) if (next === null || w.until < next) next = w.until;
    return next;
  }

  /** the runtime keeps one wakeup per session, so a booking replaces the one before it: that
   * row ends here, since the turn it was waiting for is now this booking's */
  start(toolId: string, until: number): void {
    this.wake("rebooked");
    const wait = Math.max(0, until - Date.now()) + (this.deps.graceMs ?? GRACE_MS);
    const timer = setTimeout(() => this.finish(toolId, "no turn came; the row stops waiting", false), wait);
    timer.unref?.();
    this.held.set(toolId, { until, timer });
    this.deps.onChange?.();
  }

  /** a turn of the agent's own began: the wakeup fired */
  wake(how: string): void {
    for (const toolId of [...this.held.keys()]) this.finish(toolId, how, false);
  }

  /** the agent ended the loop: nothing is coming for the booking */
  stop(): void {
    this.wake("the loop was ended");
  }

  /** the agent's process is going, and the timer it held with it */
  endAll(reason: string): void {
    for (const toolId of [...this.held.keys()]) this.finish(toolId, reason, true);
  }

  private finish(toolId: string, output: string, isError: boolean) {
    const w = this.held.get(toolId);
    if (!w) return;
    clearTimeout(w.timer);
    this.held.delete(toolId);
    this.deps.note({ type: "tool-end", toolId, output, isError });
    this.deps.onChange?.();
  }
}
