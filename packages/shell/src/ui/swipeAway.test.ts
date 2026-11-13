import { describe, expect, test } from "bun:test";
import { flung, leaveMs, leftAt, NO_ROLL, releaseSpeed, rolled, swipeAxis } from "./swipeAway.ts";

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
    const next = rolled(r, { deltaX, deltaY }, now, FAR);
    r = next.next;
    thrown ||= next.thrown;
    now += gap;
  }
  return { ...r, thrown };
}
const times = (n: number, e: [number, number]) => Array.from({ length: n }, () => e);
/** half a window 800 tall */
const FAR = 400;

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
    const r = roll(times(120, [0, 5]), 16);
    expect(r.dy).toBe(-600);
    expect(r.thrown).toBe(0);
  });
  test("fingers still on it and moving fast are a drag, not a throw", () => {
    const r = roll(times(8, [0, 40]), 16);
    expect(r.dy).toBe(-320);
    expect(r.thrown).toBe(0);
  });
  test("carried past halfway at a throw's speed it is thrown, signed the way it went", () => {
    expect(roll(times(10, [0, 40]), 16).thrown).toBeCloseTo(-2.5);
    expect(roll(times(10, [0, -40]), 16).thrown).toBeCloseTo(2.5);
  });
  test("a flick's momentum is what throws it, and a weak one's runs out first", () => {
    const momentum = (from: number): Array<[number, number]> =>
      Array.from({ length: 80 }, (_, i) => [0, Math.round(from * 0.955 ** i)]);
    expect(roll([...times(4, [0, 40]), ...momentum(40)], 16).thrown).not.toBe(0);
    expect(roll([...times(4, [0, 12]), ...momentum(12)], 16).thrown).toBe(0);
  });
  test("past halfway but on its way back is not thrown", () => {
    const r = roll([...times(120, [0, 5]), ...times(4, [0, -40])], 16);
    expect(r.dy).toBe(-440);
    expect(r.thrown).toBe(0);
  });
  test("a mouse wheel's one notch is a nudge; a spin is a throw", () => {
    expect(roll([[0, 100]], 60).thrown).toBe(0);
    expect(roll(times(3, [0, 100]), 60).thrown).toBe(0);
    expect(roll(times(5, [0, 100]), 60).thrown).not.toBe(0);
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

describe("a wheel that went quiet", () => {
  test("short of halfway the thing drops back, however fast it got there", () => {
    expect(leftAt(roll(times(8, [0, 40]), 16), FAR)).toBe(0);
    expect(leftAt(roll(times(30, [0, 5]), 16), FAR)).toBe(0);
  });
  test("carried past halfway it goes the rest of the way, the way it was carried", () => {
    expect(leftAt(roll(times(90, [0, 5]), 16), FAR)).toBeLessThan(0);
    expect(leftAt(roll(times(90, [0, -5]), 16), FAR)).toBeGreaterThan(0);
  });
  test("sideways leaves nothing to decide", () => {
    expect(leftAt(roll(times(30, [40, 0]), 16), FAR)).toBe(0);
  });
});

describe("how long the throw takes", () => {
  test("the rest of the way at the finger's speed, within reason", () => {
    expect(leaveMs(400, 2)).toBe(200);
    expect(leaveMs(800, 1)).toBe(220);
    expect(leaveMs(50, 4)).toBe(80);
  });
});
