import { describe, expect, test } from "bun:test";
import { createPeekHover } from "./peekHover.ts";

/** a peek with the delay in hand: `tick` is the wait running out */
function peek() {
  const log: string[] = [];
  let pending: (() => void) | null = null;
  const hover = createPeekHover({
    show: () => log.push("show"),
    hide: () => log.push("hide"),
    hold: (on) => log.push(on ? "hold" : "release"),
    wait: (fn) => {
      pending = fn;
      return () => {
        pending = null;
      };
    },
  });
  const tick = () => {
    const fn = pending;
    pending = null;
    fn?.();
  };
  return { hover, log, tick, armed: () => pending !== null };
}

const A = { x: 100, y: 100 };
const B = { x: 140, y: 100 };

describe("a chip's peek answers the hand", () => {
  test("a move onto the chip opens it after the wait, a move off closes it", () => {
    const { hover, log, tick } = peek();
    hover.enter(A, true);
    expect(log).toEqual([]);
    tick();
    hover.leave(B, true);
    expect(log).toEqual(["show", "hide"]);
  });

  test("a sweep across the chip opens nothing", () => {
    const { hover, log, armed } = peek();
    hover.enter(A, true);
    hover.leave(B, true);
    expect(armed()).toBe(false);
    expect(log).toEqual([]);
  });

  test("a chip scrolled out from under a resting pointer keeps its peek until the pointer moves", () => {
    const { hover, log, tick } = peek();
    hover.enter(A, true);
    tick();
    hover.leave(A, false);
    expect(log).toEqual(["show", "hold"]);
    // the same place again is the page, not the hand
    hover.away(A);
    expect(log).toEqual(["show", "hold"]);
    hover.away(B);
    expect(log).toEqual(["show", "hold", "release", "hide"]);
  });

  test("a press closes a held peek", () => {
    const { hover, log, tick } = peek();
    hover.enter(A, true);
    tick();
    hover.leave(A, false);
    hover.press();
    expect(log).toEqual(["show", "hold", "release", "hide"]);
  });

  test("a held peek whose chip scrolls back under the pointer is an ordinary hover again", () => {
    const { hover, log, tick } = peek();
    hover.enter(A, true);
    tick();
    hover.leave(A, false);
    hover.enter(A, false);
    expect(log).toEqual(["show", "hold", "release"]);
    hover.leave(B, true);
    expect(log).toEqual(["show", "hold", "release", "hide"]);
  });

  test("a chip scrolled under a resting pointer opens only once the pointer moves on it", () => {
    const { hover, log, tick, armed } = peek();
    hover.enter(A, false);
    hover.move(A);
    expect(armed()).toBe(false);
    hover.move(B);
    tick();
    expect(log).toEqual(["show"]);
  });

  test("a chip scrolled under and out again opens nothing and holds nothing", () => {
    const { hover, log, armed } = peek();
    hover.enter(A, false);
    hover.leave(A, false);
    hover.move(B);
    expect(armed()).toBe(false);
    expect(log).toEqual([]);
  });

  test("a chip scrolled away before the wait runs out does not open", () => {
    const { hover, log, tick } = peek();
    hover.enter(A, true);
    hover.leave(A, false);
    tick();
    expect(log).toEqual([]);
  });
});
