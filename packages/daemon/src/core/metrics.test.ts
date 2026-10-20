import { expect, test } from "bun:test";
import { describeLag, LagMinute, SLEEP_MS } from "./metrics.ts";

const MINUTE = 60_000;

test("a minute's late ticks are one line, said on the next minute's first tick, with the worst and its git call", () => {
  const m = new LagMinute();
  const t0 = 100 * MINUTE;
  expect(m.note(t0, 0, null)).toBeNull();
  expect(m.note(t0 + 250, 120, { cmd: "git rev-parse HEAD", ms: 80 })).toBeNull();
  expect(m.note(t0 + 500, 1174, { cmd: "git status --porcelain -uall", ms: 949 })).toBeNull();
  expect(m.note(t0 + 750, 60, null)).toBeNull();
  // a tick under the threshold is not a late tick
  expect(m.note(t0 + 1000, 10, null)).toBeNull();
  const line = m.note(t0 + MINUTE, 0, null);
  expect(line).toEqual({ ticks: 3, worst: 1174, git: "git status --porcelain -uall", gitMs: 949 });
  expect(describeLag(line!)).toBe(
    "event loop late 3 times in the last minute, worst 1174ms after git status --porcelain -uall (949ms)",
  );
});

test("one late tick reads once, and a worst tick with no git call near it names none", () => {
  const m = new LagMinute();
  const t0 = 200 * MINUTE;
  expect(m.note(t0 + 250, 70, null)).toBeNull();
  const line = m.note(t0 + MINUTE, 0, null);
  expect(line).toEqual({ ticks: 1, worst: 70, git: null, gitMs: null });
  expect(describeLag(line!)).toBe("event loop late once in the last minute, worst 70ms");
});

test("a quiet minute says nothing, and the minute after it starts its own count", () => {
  const m = new LagMinute();
  const t0 = 300 * MINUTE;
  m.note(t0, 90, null);
  expect(m.note(t0 + MINUTE, 0, null)).toMatchObject({ ticks: 1 });
  // the whole of the second minute is quiet: the third minute's first tick has nothing to say
  expect(m.note(t0 + MINUTE + 30_000, 0, null)).toBeNull();
  expect(m.note(t0 + 2 * MINUTE, 55, null)).toBeNull();
  expect(m.note(t0 + 3 * MINUTE, 0, null)).toMatchObject({ ticks: 1, worst: 55 });
});

test("a tick late by more than the sleep cutoff is the machine asleep and counts for nothing", () => {
  const m = new LagMinute();
  const t0 = 400 * MINUTE;
  m.note(t0, SLEEP_MS + 10_000, { cmd: "git fetch", ms: SLEEP_MS });
  expect(m.note(t0 + MINUTE, 0, null)).toBeNull();
  // right at the cutoff is still a stall worth a line
  m.note(t0 + MINUTE + 250, SLEEP_MS, null);
  expect(m.note(t0 + 2 * MINUTE, 0, null)).toEqual({ ticks: 1, worst: SLEEP_MS, git: null, gitMs: null });
});
