import { describe, expect, test } from "bun:test";
import { NO_GESTURE, type WheelGesture, wheelAxis } from "./hooks.ts";

/** runs the events through one gesture, a few ms apart, and says which scrolled */
function run(events: Array<[number, number]>, start: WheelGesture = NO_GESTURE, from = 1000) {
  let g = start;
  const scrolled: boolean[] = [];
  let now = from;
  for (const [deltaX, deltaY] of events) {
    const r = wheelAxis(g, { deltaX, deltaY }, now);
    scrolled.push(r.scrolls);
    g = r.next;
    now += 16;
  }
  return { scrolled, gesture: g };
}

describe("wheelAxis", () => {
  test("a trackpad's first fraction of a pixel sideways is held, the vertical scroll after it goes", () => {
    const { scrolled, gesture } = run([
      [0.5, 0.1],
      [0, 12],
      [0, 12],
    ]);
    expect(scrolled).toEqual([false, true, true]);
    expect(gesture.axis).toBe("y");
  });

  test("a mouse wheel's tick settles the axis and scrolls at once", () => {
    expect(run([[0, 100]]).scrolled).toEqual([true]);
    expect(run([[100, 0]]).scrolled).toEqual([true]);
  });

  test("a lean during a vertical gesture is dropped; a turn is taken", () => {
    const { scrolled, gesture } = run([
      [0, 12],
      [1.5, 0.2],
      [0, 12],
      [6, 0.5],
      [3, 0],
    ]);
    expect(scrolled).toEqual([true, false, true, true, true]);
    expect(gesture.axis).toBe("x");
  });

  test("a slow sideways gesture turns on its travel when the fingers landed leaning down", () => {
    const { scrolled, gesture } = run([
      [1, 2],
      [2, 0],
      [1, 0],
      [2, 1],
      [2, 0],
      [1, 0],
    ]);
    expect(scrolled).toEqual([true, false, false, true, true, true]);
    expect(gesture.axis).toBe("x");
  });

  test("a resting hand's jitter during a vertical gesture never adds up to a turn", () => {
    const { scrolled, gesture } = run([
      [0, 12],
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 12],
    ]);
    expect(scrolled).toEqual([true, false, true, false, true, false, true, false, true]);
    expect(gesture.axis).toBe("y");
  });

  test("a slow sideways gesture settles on its travel and then takes every fraction", () => {
    const { scrolled } = run([
      [0.8, 0],
      [0.8, 0],
      [0.6, 0],
      [0.4, 0.1],
    ]);
    expect(scrolled).toEqual([false, false, true, true]);
  });

  test("an even lean goes to the vertical, as the editor's own tie does", () => {
    const { gesture } = run([[2, 2]]);
    expect(gesture.axis).toBe("y");
  });

  test("quiet ends a gesture: the next event starts fresh", () => {
    const first = run([[0, 12]]).gesture;
    const soon = wheelAxis(first, { deltaX: 1, deltaY: 0 }, first.at + 100);
    expect(soon.scrolls).toBe(false);
    const later = wheelAxis(first, { deltaX: 1, deltaY: 0 }, first.at + 400);
    expect(later.scrolls).toBe(false);
    expect(later.next.axis).toBeNull();
    expect(later.next.dx).toBe(1);
  });
});
