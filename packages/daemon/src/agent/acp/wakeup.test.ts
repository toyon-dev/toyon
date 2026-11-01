import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import { loopEnds, WAKEUP_TOOL, Wakeups, wakeupAt } from "./wakeup.ts";

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(5);
  expect(ok()).toBe(true);
};

describe("wakeupAt", () => {
  test("the booked time is now plus the delay, held to the range the runtime allows", () => {
    expect(wakeupAt(WAKEUP_TOOL, { delaySeconds: 600, reason: "watching CI" }, 1000)).toBe(1000 + 600_000);
    expect(wakeupAt(WAKEUP_TOOL, { delaySeconds: 5 }, 1000)).toBe(1000 + 60_000);
    expect(wakeupAt(WAKEUP_TOOL, { delaySeconds: 99_999 }, 1000)).toBe(1000 + 3_600_000);
  });
  test("not a wakeup: another tool, the loop ending, or no delay to book", () => {
    expect(wakeupAt("Bash", { delaySeconds: 600 })).toBeNull();
    expect(wakeupAt(WAKEUP_TOOL, { stop: true })).toBeNull();
    expect(wakeupAt(WAKEUP_TOOL, { reason: "x" })).toBeNull();
    expect(wakeupAt(WAKEUP_TOOL, { delaySeconds: "600" })).toBeNull();
    expect(wakeupAt(WAKEUP_TOOL, null)).toBeNull();
  });
  test("the loop's end is the wakeup call with stop, and nothing else", () => {
    expect(loopEnds(WAKEUP_TOOL, { stop: true })).toBe(true);
    expect(loopEnds(WAKEUP_TOOL, { delaySeconds: 600 })).toBe(false);
    expect(loopEnds(WAKEUP_TOOL, { stop: "yes" })).toBe(false);
    expect(loopEnds("Bash", { stop: true })).toBe(false);
    expect(loopEnds(WAKEUP_TOOL, null)).toBe(false);
  });
});

describe("Wakeups", () => {
  function held(graceMs?: number) {
    const events: AgentEvent[] = [];
    let changes = 0;
    const wakeups = new Wakeups({
      note: (e) => events.push(e),
      onChange: () => changes++,
      ...(graceMs !== undefined ? { graceMs } : {}),
    });
    return { wakeups, events, changes: () => changes };
  }

  test("a booking replaces the one before it, and a turn beginning ends the row with the word for how the agent came back", () => {
    const { wakeups, events, changes } = held();
    wakeups.start("w1", 5000);
    expect(changes()).toBe(1);
    // the runtime keeps one wakeup: a second booking is the loop re-paced, and the first row ends
    wakeups.start("w2", 3000);
    expect(events).toEqual([{ type: "tool-end", toolId: "w1", output: "rebooked", isError: false }]);
    expect(wakeups.size).toBe(1);
    expect(wakeups.next).toBe(3000);
    expect(changes()).toBe(3);
    wakeups.wake("woke");
    expect(events.at(-1)).toEqual({ type: "tool-end", toolId: "w2", output: "woke", isError: false });
    expect(wakeups.size).toBe(0);
    expect(wakeups.next).toBeNull();
    expect(changes()).toBe(4);
    // nothing held: nothing said
    wakeups.wake("woke");
    expect(events.length).toBe(2);
  });

  test("the agent ending the loop ends the row it booked, not as an error", () => {
    const { wakeups, events } = held();
    wakeups.start("w1", Date.now() + 60_000);
    wakeups.stop();
    expect(events).toEqual([{ type: "tool-end", toolId: "w1", output: "the loop was ended", isError: false }]);
    expect(wakeups.size).toBe(0);
  });

  test("the agent stopping ends the row as an error, since the booking went with the process", () => {
    const { wakeups, events } = held();
    wakeups.start("w1", Date.now() + 60_000);
    wakeups.endAll("the agent stopped before it woke");
    expect(events).toEqual([
      { type: "tool-end", toolId: "w1", output: "the agent stopped before it woke", isError: true },
    ]);
  });

  test("no turn a grace past the booked time: the row stops waiting, not as an error", async () => {
    const { wakeups, events } = held(10);
    wakeups.start("w1", Date.now() - 1);
    await until(() => events.length === 1);
    expect(events[0]).toEqual({
      type: "tool-end",
      toolId: "w1",
      output: "no turn came; the row stops waiting",
      isError: false,
    });
    expect(wakeups.size).toBe(0);
  });
});
