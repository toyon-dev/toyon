// Where a rendered document changed, as a strip down its right edge: the one the diff pane draws
// beside its code, measured the way Monaco measures that one, so a file read as a page and read as
// text maps its changes and drags its viewport alike.

/** a stretch from top to bottom, in px: of the document's whole height, or of the strip */
export interface Span {
  top: number;
  bottom: number;
}

/** the least a mark is tall: a changed word in a long document maps to a hair, and a hair is not
 * seen */
const MARK_MIN = 4;

/** the least the viewport is tall, so there is something to take hold of in a long document */
const VIEW_MIN = 20;

/** Stretches of a document `total` tall as marks on a strip `height` tall: whole pixels, a short
 * one grown about its middle, and those that touch drawn as one. */
export function marksOf(spans: readonly Span[], total: number, height: number): Span[] {
  if (total <= 0 || height <= 0) return [];
  const scale = height / total;
  const marks = spans
    .map((s) => {
      let top = Math.round(s.top * scale);
      let bottom = Math.round(s.bottom * scale);
      if (bottom - top < MARK_MIN) {
        top = Math.round(((s.top + s.bottom) / 2) * scale) - MARK_MIN / 2;
        bottom = top + MARK_MIN;
      }
      // a mark grown past an end of the strip is moved back onto it, not cut
      const over = Math.max(0, bottom - height) || Math.min(0, top);
      return { top: Math.max(0, top - over), bottom: Math.min(height, bottom - over) };
    })
    .sort((a, b) => a.top - b.top);
  const out: Span[] = [];
  for (const mark of marks) {
    const last = out[out.length - 1];
    if (last && mark.top <= last.bottom) last.bottom = Math.max(last.bottom, mark.bottom);
    else out.push(mark);
  }
  return out;
}

/** the viewport on the strip: where it stands, how tall it is, and how far it moves for each px
 * the document scrolls */
export interface View {
  top: number;
  height: number;
  ratio: number;
}

/** the viewport for a box `visible` tall showing a document `total` tall, scrolled to `scrollTop` */
export function viewOf(visible: number, total: number, scrollTop: number): View {
  if (total <= visible) return { top: 0, height: visible, ratio: 0 };
  const height = Math.max(VIEW_MIN, Math.floor((visible * visible) / total));
  const ratio = (visible - height) / (total - visible);
  return { top: Math.round(scrollTop * ratio), height, ratio };
}

/** the scroll that puts the middle of the viewport at `y` on the strip */
export function scrollAt(y: number, view: View): number {
  return view.ratio ? (y - view.height / 2) / view.ratio : 0;
}
