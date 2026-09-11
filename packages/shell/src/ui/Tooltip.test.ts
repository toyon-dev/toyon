import { describe, expect, test } from "bun:test";
import { type Anchor, place } from "./Tooltip.tsx";

// place() reads three things from the DOM: the anchor's rect, the box's size and the viewport.
// Fakes for those are enough to hold the flip and clamp rules without a browser.
const VW = 1000;
const VH = 600;
const BOX = { w: 200, h: 30 };

function setup(rect: { left: number; top: number; width: number; height: number }, placement: Anchor["placement"]) {
  Object.assign(globalThis, { window: { innerWidth: VW, innerHeight: VH } });
  const el = {
    getBoundingClientRect: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }),
  } as unknown as HTMLElement;
  const box = {
    offsetWidth: BOX.w,
    offsetHeight: BOX.h,
    style: { top: "", left: "" },
    dataset: {} as Record<string, string>,
  };
  place(box as unknown as HTMLDivElement, { el, text: "t", placement }, { x: 0, y: 0 });
  return {
    side: box.dataset.side,
    top: Number.parseInt(box.style.top, 10),
    left: Number.parseInt(box.style.left, 10),
  };
}

describe("tooltip placement", () => {
  test("a side placement centres on the anchor's height and sits clear of its edge", () => {
    const r = setup({ left: 700, top: 100, width: 300, height: 40 }, "left");
    expect(r.side).toBe("left");
    expect(r.left + BOX.w).toBeLessThan(700);
    expect(r.top).toBe(105);
  });

  test("right flips to left when the right edge has no room", () => {
    const r = setup({ left: 700, top: 100, width: 300, height: 40 }, "right");
    expect(r.side).toBe("left");
    expect(r.left + BOX.w).toBeLessThanOrEqual(700);
  });

  test("left flips to right when the left edge has no room", () => {
    const r = setup({ left: 0, top: 100, width: 100, height: 40 }, "left");
    expect(r.side).toBe("right");
    expect(r.left).toBeGreaterThanOrEqual(100);
  });

  test("bottom flips to top at the foot of the viewport", () => {
    const r = setup({ left: 400, top: VH - 30, width: 40, height: 20 }, "bottom");
    expect(r.side).toBe("top");
    expect(r.top + BOX.h).toBeLessThan(VH - 30);
  });

  test("top flips to bottom at the head of the viewport", () => {
    const r = setup({ left: 400, top: 4, width: 40, height: 20 }, "top");
    expect(r.side).toBe("bottom");
  });

  test("the box never leaves the viewport, whichever side wins", () => {
    for (const placement of ["top", "bottom", "left", "right", "follow"] as const) {
      for (const rect of [
        { left: 0, top: 0, width: 20, height: 20 },
        { left: VW - 20, top: VH - 20, width: 20, height: 20 },
        { left: 0, top: 0, width: VW, height: VH },
      ]) {
        const r = setup(rect, placement);
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.top).toBeGreaterThanOrEqual(0);
        expect(r.left + BOX.w).toBeLessThanOrEqual(VW);
        expect(r.top + BOX.h).toBeLessThanOrEqual(VH);
      }
    }
  });
});
