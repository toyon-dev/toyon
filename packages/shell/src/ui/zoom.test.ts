import { describe, expect, test } from "bun:test";
import { about, type Bounds, clampTo, maxScale, REST, resting, settled, TAP_SCALE, tapZoom } from "./zoom.ts";

/** a picture that fits the window with room beside it */
const fit: Bounds = { w: 400, h: 300, W: 800, H: 600, max: 4 };

describe("zooming about a point", () => {
  test("what stood under the fingers stays under them", () => {
    // the picture's top right corner (200, -150) pinched to double
    const z = about(REST, 2, { x: 200, y: -150 }, { x: 200, y: -150 });
    expect(z).toEqual({ s: 2, x: -200, y: 150 });
    // and that corner, scaled then carried, is where it was
    expect(200 * z.s + z.x).toBe(200);
    expect(-150 * z.s + z.y).toBe(-150);
  });
  test("fingers that moved carry it with them", () => {
    const z = about(REST, 1, { x: 0, y: 0 }, { x: 30, y: 10 });
    expect(z).toEqual({ s: 1, x: 30, y: 10 });
  });
  test("from somewhere already zoomed", () => {
    const z0 = { s: 2, x: -100, y: 0 };
    // the point at (100, 0) in the window is the picture's (100, 0) at z0; keep it there at 3x
    const z = about(z0, 3, { x: 100, y: 0 }, { x: 100, y: 0 });
    expect(100 * z.s + z.x).toBeCloseTo(100);
  });
});

describe("held over the window", () => {
  test("smaller than the window it is centred", () => {
    expect(clampTo({ s: 1, x: 50, y: -40 }, fit)).toEqual(REST);
  });
  test("larger, its edge goes no further in than the window's", () => {
    // 400 * 4 = 1600 wide in an 800 window: 400 either way, no more
    expect(clampTo({ s: 4, x: 900, y: 0 }, fit)).toEqual({ s: 4, x: 400, y: 0 });
    expect(clampTo({ s: 4, x: -900, y: -2000 }, fit)).toEqual({ s: 4, x: -400, y: -300 });
  });
});

describe("where a let-go leaves it", () => {
  test("pinched smaller than fit, it comes back to rest", () => {
    expect(settled({ s: 0.6, x: 20, y: 20 }, fit)).toEqual(REST);
  });
  test("past the far end it stops there", () => {
    expect(settled({ s: 9, x: 0, y: 0 }, fit).s).toBe(4);
  });
  test("in bounds it stays put", () => {
    expect(settled({ s: 2, x: 0, y: 0 }, fit)).toEqual({ s: 2, x: 0, y: 0 });
  });
});

describe("a double tap", () => {
  test("goes in about the finger", () => {
    const z = tapZoom(REST, { x: 20, y: 10 }, fit);
    expect(z.s).toBe(TAP_SCALE);
    expect(20 * z.s + z.x).toBeCloseTo(20);
    expect(10 * z.s + z.y).toBeCloseTo(10);
    expect(resting(z)).toBe(false);
  });
  test("near the edge, the edge wins over the finger", () => {
    // 400 * 2.5 = 1000 wide in an 800 window leaves 100 either way; tapped at 100 the picture
    // would need 150 and gets the 100
    const z = tapZoom(REST, { x: 100, y: 0 }, fit);
    expect(z.x).toBe(-100);
  });
  test("anywhere but rest it goes back", () => {
    expect(tapZoom({ s: 1.3, x: 0, y: 0 }, { x: 0, y: 0 }, fit)).toEqual(REST);
    expect(tapZoom({ s: TAP_SCALE, x: -50, y: 0 }, { x: 0, y: 0 }, fit)).toEqual(REST);
  });
});

describe("how far in", () => {
  test("to the picture's own pixels, and fourfold at least", () => {
    expect(maxScale(3000, 375)).toBe(8);
    expect(maxScale(200, 200)).toBe(4);
    expect(maxScale(200, 0)).toBe(4);
  });
});
