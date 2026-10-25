import { describe, expect, test } from "bun:test";
import { FLICK } from "./slide.ts";
import { COMMIT, swipeAt, swipeLetGo, swipeWay } from "./swipe.ts";

describe("whose a touch is", () => {
  test("nobody's until it has travelled", () => {
    expect(swipeWay({ dx: 5, dy: -3 })).toBe(null);
  });
  test("along the screen it is a swipe, named by the way the finger goes", () => {
    expect(swipeWay({ dx: -20, dy: 4 })).toBe("left");
    expect(swipeWay({ dx: 20, dy: -4 })).toBe("right");
  });
  test("up or down is the scroll's", () => {
    expect(swipeWay({ dx: 6, dy: 20 })).toBe("other");
    expect(swipeWay({ dx: -6, dy: -20 })).toBe("other");
  });
  test("a diagonal with nothing to choose between is the scroll's", () => {
    expect(swipeWay({ dx: 12, dy: 12 })).toBe("other");
  });
});

describe("where a finger has brought the track", () => {
  test("follows the finger the swipe's way", () => {
    expect(swipeAt(-80, 390, "left")).toBe(-80);
    expect(swipeAt(80, 390, "right")).toBe(80);
  });
  test("stops when the neighbour is fully in", () => {
    expect(swipeAt(-500, 390, "left")).toBe(-390);
    expect(swipeAt(500, 390, "right")).toBe(390);
  });
  test("goes no further back than where it started", () => {
    expect(swipeAt(30, 390, "left")).toBe(0);
    expect(swipeAt(-30, 390, "right")).toBe(0);
  });
});

describe("whether a let-go goes through", () => {
  test("put down past a third of the width it does, short of it it does not", () => {
    expect(swipeLetGo(-390 * COMMIT, 390, "left", 0)).toBe(true);
    expect(swipeLetGo(-100, 390, "left", 0)).toBe(false);
    expect(swipeLetGo(140, 390, "right", 0)).toBe(true);
  });
  test("a flick the swipe's way goes through from anywhere", () => {
    expect(swipeLetGo(-40, 390, "left", -FLICK)).toBe(true);
    expect(swipeLetGo(40, 390, "right", FLICK)).toBe(true);
  });
  test("a flick back drops it however far it had come", () => {
    expect(swipeLetGo(-300, 390, "left", FLICK)).toBe(false);
    expect(swipeLetGo(300, 390, "right", -FLICK)).toBe(false);
  });
  test("a slow drift back from past the third still stands where it is", () => {
    expect(swipeLetGo(-300, 390, "left", 0.1)).toBe(true);
  });
});
