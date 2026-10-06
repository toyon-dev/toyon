import { describe, expect, test } from "bun:test";
import { swipeAxis, swipeEnds } from "./swipeAway.ts";

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

describe("where a drag let go leaves the thing", () => {
  test("a short slow drag drops it back", () => {
    expect(swipeEnds({ dy: 40, ms: 600 })).toBe(false);
  });
  test("a long one takes it away, either way", () => {
    expect(swipeEnds({ dy: 120, ms: 900 })).toBe(true);
    expect(swipeEnds({ dy: -120, ms: 900 })).toBe(true);
  });
  test("a throw takes it away before it has gone far", () => {
    expect(swipeEnds({ dy: -40, ms: 60 })).toBe(true);
  });
  test("a twitch is not a throw", () => {
    expect(swipeEnds({ dy: 12, ms: 10 })).toBe(false);
  });
});
