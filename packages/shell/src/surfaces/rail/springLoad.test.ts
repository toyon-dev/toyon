import { describe, expect, test } from "bun:test";
import { createSpringLoad, SPRING_HOLD_MS } from "./springLoad.ts";

/** a clock the test advances by hand, standing in for setTimeout */
function fakeTimers() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => {
      const id = ++next;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle: unknown) => {
      due.delete(handle as number);
    },
    // in due order, not set order: a leave's short wait outruns a row's longer one however they
    // were queued, and a timer the earlier one cleared does not fire
    tick(ms: number) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now || !due.has(id)) continue;
        due.delete(id);
        t.fn();
      }
    },
  };
}

function harness() {
  const timers = fakeTimers();
  const held: boolean[] = [];
  const landed: string[] = [];
  const spring = createSpringLoad((on) => held.push(on), timers);
  const row = (id: string) => ({ id, land: () => landed.push(id) });
  return { timers, held, landed, spring, row };
}

describe("createSpringLoad", () => {
  test("a drag over the rail unfurls it at once, and lands on nothing between the rows", () => {
    const { timers, held, landed, spring } = harness();
    spring.over(null);
    expect(held).toEqual([true]);
    timers.tick(SPRING_HOLD_MS * 2);
    expect(landed).toEqual([]);
  });
  test("a drag resting on a row lands on it after the wait, once", () => {
    const { timers, held, landed, spring, row } = harness();
    spring.over(row("a"));
    spring.over(row("a"));
    timers.tick(SPRING_HOLD_MS - 1);
    expect(landed).toEqual([]);
    spring.over(row("a"));
    timers.tick(1);
    expect(landed).toEqual(["a"]);
    spring.over(row("a"));
    timers.tick(SPRING_HOLD_MS);
    expect(landed).toEqual(["a"]);
    expect(held).toEqual([true]);
  });
  test("a drag crossing the rows lands on none of them", () => {
    const { timers, landed, spring, row } = harness();
    spring.over(row("a"));
    timers.tick(SPRING_HOLD_MS / 2);
    spring.over(row("b"));
    timers.tick(SPRING_HOLD_MS / 2);
    spring.over(row("c"));
    timers.tick(SPRING_HOLD_MS / 2);
    spring.over(null);
    timers.tick(SPRING_HOLD_MS);
    expect(landed).toEqual([]);
  });
  test("a move between a row's own parts does not restart its wait", () => {
    const { timers, landed, spring, row } = harness();
    spring.over(row("a"));
    timers.tick(SPRING_HOLD_MS / 2);
    spring.leave();
    spring.over(row("a"));
    timers.tick(SPRING_HOLD_MS / 2);
    expect(landed).toEqual(["a"]);
  });
  test("a leave with no over behind it drops the panel and the row it was waiting on", () => {
    const { timers, held, landed, spring, row } = harness();
    spring.over(row("a"));
    spring.leave();
    timers.tick(SPRING_HOLD_MS);
    expect(held).toEqual([true, false]);
    expect(landed).toEqual([]);
  });
  test("a drag that ends without a word drops the panel on its own", () => {
    const { timers, held, spring } = harness();
    spring.over(null);
    timers.tick(2500);
    expect(held).toEqual([true, false]);
  });
  test("the drop ends everything, and a later end says nothing twice", () => {
    const { timers, held, landed, spring, row } = harness();
    spring.over(row("a"));
    spring.end();
    spring.end();
    timers.tick(SPRING_HOLD_MS);
    expect(held).toEqual([true, false]);
    expect(landed).toEqual([]);
  });
});
