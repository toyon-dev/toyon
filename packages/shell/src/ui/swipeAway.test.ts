import { describe, expect, test } from "bun:test";
import { flung, leaveMs, releaseSpeed, swipeAxis } from "./swipeAway.ts";

describe("whose a touch is", () => {
  test("nobody's until it has travelled", () => {
    expect(swipeAxis({ dx: 3, dy: -5 })).toBe(null);
  });
  test("up or down takes the thing away", () => {
    expect(swipeAxis({ dx: 4, dy: 20 })).toBe("away");
    expect(swipeAxis({ dx: -4, dy: -20 })).toBe("away");
  });
  test("sideways is left to the swipe back", () => {
    expect(swipeAxis({ dx: 30, dy: 6 })).toBe("other");
  });
});

describe("the speed a finger let go at", () => {
  test("is read over the tail of the drag, not from where it started", () => {
    // a slow start, then a flick down
    const speed = releaseSpeed(
      [
        { y: 0, t: 0 },
        { y: 10, t: 400 },
        { y: 20, t: 500 },
        { y: 100, t: 560 },
      ],
      560,
    );
    expect(speed).toBeCloseTo(80 / 60);
    expect(flung(speed)).toBe(true);
  });
  test("a finger that stopped and lifted is going nowhere however far it came", () => {
    const speed = releaseSpeed(
      [
        { y: 0, t: 0 },
        { y: 300, t: 200 },
      ],
      600,
    );
    expect(speed).toBe(0);
    expect(flung(speed)).toBe(false);
  });
  test("a slow drag to the edge is put down, and drops back", () => {
    const speed = releaseSpeed(
      [
        { y: 380, t: 900 },
        { y: 400, t: 1000 },
      ],
      1000,
    );
    expect(flung(speed)).toBe(false);
  });
  test("a throw upward is signed that way", () => {
    expect(
      releaseSpeed(
        [
          { y: 200, t: 0 },
          { y: 100, t: 50 },
        ],
        50,
      ),
    ).toBe(-2);
  });
});

describe("how long the throw takes", () => {
  test("the rest of the way at the finger's speed, within reason", () => {
    expect(leaveMs(400, 2)).toBe(200);
    expect(leaveMs(800, 1)).toBe(320);
    expect(leaveMs(50, 4)).toBe(120);
  });
});
