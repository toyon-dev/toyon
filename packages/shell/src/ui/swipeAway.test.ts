import { describe, expect, test } from "bun:test";
import { flung, leaveMs, NO_ROLL, releaseSpeed, rolled, swipeAxis } from "./swipeAway.ts";

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

/** runs wheel events through one gesture, `gap` ms apart, and says where it ended and whether any
 * of them was the throw */
function roll(events: Array<[number, number]>, gap: number) {
  let r = NO_ROLL;
  let thrown = 0;
  let now = 1000;
  for (const [deltaX, deltaY] of events) {
    const next = rolled(r, { deltaX, deltaY }, now);
    r = next.next;
    thrown ||= next.thrown;
    now += gap;
  }
  return { ...r, thrown };
}
const times = (n: number, e: [number, number]) => Array.from({ length: n }, () => e);

describe("a wheel carrying the thing", () => {
  test("goes against the delta, the way the page under the fingers would", () => {
    const r = roll(times(10, [0, 4]), 16);
    expect(r.axis).toBe("away");
    expect(r.dy).toBe(-40);
    expect(r.thrown).toBe(0);
  });
  test("is nobody's until it has travelled", () => {
    expect(roll([[0, 3]], 16).axis).toBe(null);
  });
  test("a slow roll follows however far it goes, and is never a throw", () => {
    expect(roll(times(60, [0, 5]), 16).thrown).toBe(0);
  });
  test("a flick is a throw while the fingers are still on it, signed the way it went", () => {
    expect(roll(times(4, [0, 40]), 16).thrown).toBeCloseTo(-2.5);
    expect(roll(times(4, [0, -40]), 16).thrown).toBeCloseTo(2.5);
  });
  test("a mouse wheel's one notch is a nudge; notches in a spin are a throw", () => {
    expect(roll([[0, 100]], 60).thrown).toBe(0);
    expect(roll(times(2, [0, 100]), 60).thrown).not.toBe(0);
  });
  test("sideways is somebody else's for the rest of the gesture, whatever it does next", () => {
    const r = roll([[30, 2], ...times(6, [0, 40])], 16);
    expect(r.axis).toBe("other");
    expect(r.thrown).toBe(0);
  });
  test("a drag let go slowly keeps its momentum and still is not thrown", () => {
    const momentum: Array<[number, number]> = [8, 7, 6, 5, 4, 3, 2, 1].map((d) => [0, d]);
    expect(roll([...times(20, [0, 6]), ...momentum], 16).thrown).toBe(0);
  });
});

describe("how long the throw takes", () => {
  test("the rest of the way at the finger's speed, within reason", () => {
    expect(leaveMs(400, 2)).toBe(200);
    expect(leaveMs(800, 1)).toBe(220);
    expect(leaveMs(50, 4)).toBe(80);
  });
});
