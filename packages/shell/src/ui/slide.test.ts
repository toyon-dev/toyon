import { describe, expect, test } from "bun:test";
import { FLICK, FLICK_WINDOW_MS, flickSpeed, rungLetGo, STEP, slideAt, slideAxis } from "./slide.ts";

describe("whose a touch is", () => {
  test("nobody's until it has travelled", () => {
    expect(slideAxis({ dx: -5, dy: 3 })).toBe(null);
  });
  test("along the row toward its start is the slide", () => {
    expect(slideAxis({ dx: -20, dy: 4 })).toBe("slide");
  });
  test("up or down is the list's scroll", () => {
    expect(slideAxis({ dx: -6, dy: 20 })).toBe("other");
    expect(slideAxis({ dx: 4, dy: -20 })).toBe("other");
  });
  test("the other way is left to the swipe back", () => {
    expect(slideAxis({ dx: 30, dy: 2 })).toBe("other");
  });
});

describe("where a finger has brought the row", () => {
  test("short of the first rung it is on none, and follows the finger", () => {
    expect(slideAt(-30, 3)).toMatchObject({ step: 0, x: -30 });
  });
  test("the well under it comes up over the first half rung", () => {
    expect(slideAt(-8, 3).well).toBeCloseTo(8 / (STEP / 2));
    expect(slideAt(-STEP / 2, 3).well).toBe(1);
    expect(slideAt(-2 * STEP, 3).well).toBe(1);
    expect(slideAt(-30, 1, 120).well).toBeCloseTo(0.5);
  });
  test("each rung is a step further", () => {
    expect(slideAt(-STEP, 3).step).toBe(1);
    expect(slideAt(-2 * STEP - 10, 3).step).toBe(2);
    expect(slideAt(-3 * STEP, 3).step).toBe(3);
  });
  test("past the last rung the row gives rather than follows", () => {
    const past = slideAt(-3 * STEP - 100, 3);
    expect(past.step).toBe(3);
    expect(past.x).toBeGreaterThan(-3 * STEP - 100);
    expect(past.x).toBeLessThan(-3 * STEP);
  });
  test("a drag the other way leaves the row where it is", () => {
    expect(slideAt(40, 3)).toEqual({ step: 0, x: -0, well: 0 });
  });
  test("a list with longer words names a wider rung", () => {
    expect(slideAt(-STEP, 1, 120).step).toBe(0);
    expect(slideAt(-120, 1, 120).step).toBe(1);
  });
});

describe("how fast the finger lifted", () => {
  /** a flick: 60px toward the row's start over 50ms, lifted on the last move */
  const flick = [
    { x: 300, t: 1000 },
    { x: 280, t: 1016 },
    { x: 260, t: 1033 },
    { x: 240, t: 1050 },
  ];
  test("is read off the moves just before the lift", () => {
    expect(flickSpeed(flick, 1050)).toBeCloseTo(60 / 50);
  });
  test("a pause before the lift reads as still, since nothing moved in the window", () => {
    expect(flickSpeed(flick, 1050 + FLICK_WINDOW_MS + 1)).toBe(0);
  });
  test("one move alone says nothing", () => {
    expect(flickSpeed([{ x: 300, t: 1000 }], 1000)).toBe(0);
    expect(flickSpeed([], 1000)).toBe(0);
  });
  test("the window drops the drag's slow start and keeps its end", () => {
    const slowThenFast = [{ x: 300, t: 0 }, { x: 290, t: 500 }, ...flick];
    expect(flickSpeed(slowThenFast, 1050)).toBeCloseTo(60 / 50);
  });
  test("moving the other way is no speed toward the start", () => {
    expect(
      flickSpeed(
        [...flick].reverse().map((s, i) => ({ x: s.x, t: 1000 + i * 16 })),
        1048,
      ),
    ).toBe(0);
  });
});

describe("the rung a let-go does", () => {
  test("the rung the finger is on, however fast it lifted", () => {
    expect(rungLetGo(2, 0, 3)).toBe(2);
    expect(rungLetGo(1, 5, 3)).toBe(1);
  });
  test("short of the first rung, a flick is the first rung", () => {
    expect(rungLetGo(0, FLICK, 3)).toBe(1);
    expect(rungLetGo(0, FLICK * 2, 1)).toBe(1);
  });
  test("short of the first rung and slow, nothing", () => {
    expect(rungLetGo(0, FLICK / 2, 3)).toBe(0);
    expect(rungLetGo(0, 0, 3)).toBe(0);
  });
  test("a row with no ladder has no rung to flick to", () => {
    expect(rungLetGo(0, FLICK * 2, 0)).toBe(0);
  });
});
