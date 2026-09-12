import { describe, expect, test } from "bun:test";
import { type Placement, place, type Rect, widthFor } from "./place.ts";

const rect = (left: number, top: number, w: number, h: number): Rect => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});
const VP = { w: 1200, h: 800 };

/** a picker's panel: it opens over the control, with its own field landing on it */
const COVER: Placement = { side: "bottom", align: "start", cover: true, offset: 6, alignOffset: 9, margin: 8 };

describe("a panel that covers the control it opened from", () => {
  test("grows down from over the chip, with the box's near edges past the chip's", () => {
    const chip = rect(100, 40, 60, 20);
    expect(place(chip, { w: 360, h: 200 }, VP, { ...COVER, flip: "both" })).toEqual({
      x: 91,
      y: 34,
      side: "bottom",
      align: "start",
    });
  });

  test("a chip at the foot of the window grows up instead, still landing on the chip", () => {
    const chip = rect(100, 700, 60, 20);
    expect(place(chip, { w: 360, h: 200 }, VP, { ...COVER, flip: "both" })).toEqual({
      x: 91,
      y: 526,
      side: "top",
      align: "start",
    });
  });

  test("a chip against the right edge hangs the panel from that edge", () => {
    const chip = rect(1100, 40, 60, 20);
    expect(place(chip, { w: 360, h: 200 }, VP, { ...COVER, flip: "both" })).toEqual({
      x: 809,
      y: 34,
      side: "bottom",
      align: "end",
    });
  });

  test("a chip in the corner turns on both axes at once", () => {
    const chip = rect(1100, 700, 60, 20);
    expect(place(chip, { w: 360, h: 200 }, VP, { ...COVER, flip: "both" })).toMatchObject({
      side: "top",
      align: "end",
    });
  });

  test("margin 0 lets the pill's panel sit against the top of the window", () => {
    // the bar is 38px and the panel leaves 3px of it showing: a clamp to the usual 8 would push it down
    const pill = rect(10, 9, 70, 20);
    expect(place(pill, { w: 460, h: 300 }, VP, { ...COVER, margin: 0 }).y).toBe(3);
  });
});

describe("the composer's menu", () => {
  const INLINE: Placement = {
    side: "top",
    align: "start",
    offset: 4,
    alignOffset: -10,
    matchWidth: -20,
    flip: "side",
    margin: 8,
  };

  test("stands on the box being typed in, inset from both its edges", () => {
    const composer = rect(820, 560, 360, 80);
    expect(place(composer, { w: 340, h: 200 }, VP, INLINE)).toEqual({ x: 830, y: 356, side: "top", align: "start" });
    expect(widthFor(composer, INLINE)).toBe(340);
  });

  test("drops below the box when there is no room above it", () => {
    const composer = rect(820, 10, 360, 80);
    expect(place(composer, { w: 340, h: 200 }, VP, INLINE)).toMatchObject({ y: 94, side: "bottom" });
  });
});

describe("when there is no room", () => {
  test("a box taller than the window keeps its start edge on screen", () => {
    const r = rect(100, 300, 100, 20);
    expect(
      place(r, { w: 100, h: 900 }, { w: 1000, h: 600 }, { side: "bottom", flip: "side", margin: 8 }),
    ).toMatchObject({ y: 8, side: "bottom" });
  });

  test("without a flip the side stands and only the clamp moves it", () => {
    const r = rect(100, 560, 100, 20);
    expect(place(r, { w: 100, h: 200 }, { w: 1000, h: 600 }, { side: "bottom", margin: 8 })).toMatchObject({
      y: 392,
      side: "bottom",
    });
  });

  test("a centred box has no other edge to line up on, so it only clamps", () => {
    const r = rect(0, 300, 40, 40);
    expect(place(r, { w: 200, h: 30 }, { w: 1000, h: 600 }, { side: "bottom", align: "center", flip: "both" })).toEqual(
      {
        x: 8,
        y: 340,
        side: "bottom",
        align: "center",
      },
    );
  });
});

describe("a box that takes its anchor's width", () => {
  test("matches it, and sizes itself when it is not asked to", () => {
    const field = rect(300, 8, 424, 22);
    expect(widthFor(field, { side: "bottom", matchWidth: 0 })).toBe(424);
    expect(widthFor(field, { side: "bottom" })).toBeUndefined();
  });
});
