/**
 * Where a floating box goes against the thing it belongs to. One function for every float in the
 * app: the menu under a row or at a pointer, the tooltip beside its control, a picker's panel over
 * the chip that opened it, the composer's menu above the box being typed in.
 *
 * Pure numbers in and out, so it is the one piece of the layering that a test can hold: the DOM
 * reads (the anchor's rect, the box's own size, the viewport) happen in Float.tsx.
 *
 * The axes are named for the side the box takes: `side` is the axis it grows along, `align` the one
 * it lines up on. Only the growth edge is measured for room, which is what "does it fit" means for
 * a box that is about to be drawn from that edge, and the clamp runs last so a box larger than the
 * viewport keeps its start edge on screen rather than its end.
 *
 * CSS anchor positioning says all of this declaratively (`position-area`, `position-try-fallbacks`,
 * `anchor-size`), and this module is shaped to be replaced by it once Firefox ships it.
 */

export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };
export type Size = { w: number; h: number };
export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
/** which axis may turn around when the box does not fit: `side` grows the other way, `align` lines
 * up on the anchor's other edge */
export type Flip = "none" | "side" | "align" | "both";

export type Placement = {
  /** the side of the anchor the box grows from */
  side: Side;
  /** which edge of the anchor it lines up on, across that axis; default centred */
  align?: Align;
  /** a gap between anchor and box along `side`; a cover placement measures it as an overlap instead */
  offset?: number;
  /** past the anchor's edge along `align`: negative pulls the box inside the anchor */
  alignOffset?: number;
  /** the box starts over the anchor rather than beside it: a picker's panel whose own field lands
   * on the control that opened it */
  cover?: boolean;
  flip?: Flip;
  /** the least space kept between the box and the edge of the window */
  margin?: number;
  /** the box takes the anchor's width plus this (0 for the route list, -20 for the composer's menu) */
  matchWidth?: number;
};

export type Placed = { x: number; y: number; side: Side; align: Align };

/** a pointer as a rect with no size: a menu at the cursor, a tooltip trailing it */
export const pointRect = (p: Point): Rect => ({ left: p.x, top: p.y, right: p.x, bottom: p.y });

/** the width a `matchWidth` box takes, or nothing when it sizes itself */
export function widthFor(anchor: Rect, p: Placement): number | undefined {
  return p.matchWidth === undefined ? undefined : Math.max(0, anchor.right - anchor.left + p.matchWidth);
}

const VERTICAL = new Set<Side>(["top", "bottom"]);
const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/** the box's start along the axis it grows on */
function mainStart(a: { start: number; end: number }, size: number, side: Side, offset: number, cover: boolean) {
  const leading = side === "top" || side === "left";
  if (cover) return leading ? a.end + offset - size : a.start - offset;
  return leading ? a.start - offset - size : a.end + offset;
}

/** room for the box drawn from that edge, the only edge that can run out */
function mainFits(pos: number, size: number, side: Side, limit: number, margin: number) {
  return side === "top" || side === "left" ? pos >= margin : pos + size <= limit - margin;
}

function crossStart(a: { start: number; end: number }, size: number, align: Align, alignOffset: number) {
  if (align === "center") return a.start + (a.end - a.start) / 2 - size / 2;
  return align === "start" ? a.start - alignOffset : a.end + alignOffset - size;
}

function crossFits(pos: number, size: number, align: Align, limit: number, margin: number) {
  return align === "start" ? pos + size <= limit - margin : pos >= margin;
}

/** keep the preference when it fits, or when turning around would not help either */
const pick = <T>(want: T, other: T, wantFits: boolean, otherFits: boolean): T =>
  wantFits || !otherFits ? want : other;

const clamp = (pos: number, size: number, limit: number, margin: number) =>
  Math.max(margin, Math.min(pos, limit - margin - size));

export function place(anchor: Rect, box: Size, viewport: Size, p: Placement): Placed {
  const { offset = 0, alignOffset = 0, cover = false, flip = "none", margin = 8 } = p;
  const vertical = VERTICAL.has(p.side);
  // the two axes, named from the box's point of view rather than the screen's
  const main = vertical
    ? { a: { start: anchor.top, end: anchor.bottom }, size: box.h, limit: viewport.h }
    : { a: { start: anchor.left, end: anchor.right }, size: box.w, limit: viewport.w };
  const cross = vertical
    ? { a: { start: anchor.left, end: anchor.right }, size: box.w, limit: viewport.w }
    : { a: { start: anchor.top, end: anchor.bottom }, size: box.h, limit: viewport.h };

  let side = p.side;
  if (flip === "side" || flip === "both") {
    const here = mainStart(main.a, main.size, side, offset, cover);
    const there = mainStart(main.a, main.size, opposite[side], offset, cover);
    side = pick(
      side,
      opposite[side],
      mainFits(here, main.size, side, main.limit, margin),
      mainFits(there, main.size, opposite[side], main.limit, margin),
    );
  }

  let align: Align = p.align ?? "center";
  // a centred box has no other edge to line up on, so it only ever clamps
  if ((flip === "align" || flip === "both") && align !== "center") {
    const other: Align = align === "start" ? "end" : "start";
    const here = crossStart(cross.a, cross.size, align, alignOffset);
    const there = crossStart(cross.a, cross.size, other, alignOffset);
    align = pick(
      align,
      other,
      crossFits(here, cross.size, align, cross.limit, margin),
      crossFits(there, cross.size, other, cross.limit, margin),
    );
  }

  const mainPos = clamp(mainStart(main.a, main.size, side, offset, cover), main.size, main.limit, margin);
  const crossPos = clamp(crossStart(cross.a, cross.size, align, alignOffset), cross.size, cross.limit, margin);
  return vertical ? { x: crossPos, y: mainPos, side, align } : { x: mainPos, y: crossPos, side, align };
}
