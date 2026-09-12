import { describe, expect, test } from "bun:test";
import { place, type Rect } from "./place.ts";
import { type TipPlacement, tipPlacement } from "./Tooltip.tsx";

// tipPlacement says what a tip is placed against and how; place() does the geometry. Both are
// numbers, so the flip and clamp rules hold without a browser.
const VP = { w: 1000, h: 600 };
const BOX = { w: 200, h: 30 };

function at(r: { left: number; top: number; width: number; height: number }, placement: TipPlacement) {
  const anchor: Rect = { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
  const tip = tipPlacement(placement, anchor, { x: 0, y: 0 });
  const { x, y, side } = place(tip.rect, BOX, VP, tip.placement);
  return { side, top: Math.round(y), left: Math.round(x) };
}

describe("tooltip placement", () => {
  test("a side placement centres on the anchor's height and sits clear of its edge", () => {
    const r = at({ left: 700, top: 100, width: 300, height: 40 }, "left");
    expect(r.side).toBe("left");
    expect(r.left + BOX.w).toBeLessThan(700);
    expect(r.top).toBe(105);
  });

  test("right flips to left when the right edge has no room", () => {
    const r = at({ left: 700, top: 100, width: 300, height: 40 }, "right");
    expect(r.side).toBe("left");
    expect(r.left + BOX.w).toBeLessThanOrEqual(700);
  });

  test("left flips to right when the left edge has no room", () => {
    const r = at({ left: 0, top: 100, width: 100, height: 40 }, "left");
    expect(r.side).toBe("right");
    expect(r.left).toBeGreaterThanOrEqual(100);
  });

  test("bottom flips to top at the foot of the viewport", () => {
    const r = at({ left: 400, top: VP.h - 30, width: 40, height: 20 }, "bottom");
    expect(r.side).toBe("top");
    expect(r.top + BOX.h).toBeLessThan(VP.h - 30);
  });

  test("top flips to bottom at the head of the viewport", () => {
    const r = at({ left: 400, top: 4, width: 40, height: 20 }, "top");
    expect(r.side).toBe("bottom");
  });

  test("the box never leaves the viewport, whichever side wins", () => {
    for (const placement of ["top", "bottom", "left", "right", "follow"] as const) {
      for (const r of [
        { left: 0, top: 0, width: 20, height: 20 },
        { left: VP.w - 20, top: VP.h - 20, width: 20, height: 20 },
        { left: 0, top: 0, width: VP.w, height: VP.h },
      ]) {
        const p = at(r, placement);
        expect(p.left).toBeGreaterThanOrEqual(0);
        expect(p.top).toBeGreaterThanOrEqual(0);
        expect(p.left + BOX.w).toBeLessThanOrEqual(VP.w);
        expect(p.top + BOX.h).toBeLessThanOrEqual(VP.h);
      }
    }
  });
});
