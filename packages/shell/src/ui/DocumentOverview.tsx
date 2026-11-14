import { type PointerEvent, type RefObject, useRef, useState, type WheelEvent } from "react";
import { cx } from "./cx.ts";
import { CAME, GONE } from "./documentDiff.ts";
import { useOnChange } from "./hooks.ts";
import { marksOf, type Span, scrollAt, viewOf } from "./overview.ts";

/** what the strip draws: what went and what came, each in its own column, and whether the
 * document runs past its box */
type Marks = { gone: Span[]; came: Span[]; scrolls: boolean };

/** a wheel that counts in lines says how many, not how far: a line of the page is about this */
const WHEEL_LINE = 20;

/**
 * Where a marked document changed, down its right edge: the strip the diff pane draws beside its
 * code. What went is on its left half and what came on its right, each where it stands in the whole
 * document, with the viewport over them. The viewport drags, a press elsewhere on the strip brings
 * it there, and the wheel scrolls the document from it, so the strip is the document's scrollbar
 * as well and the box's own is put away (document.css).
 *
 * The marks are read off the rendered page, where a mark's place is known: `root` is the scroll
 * box and `body` the page inside it, re-read when `page` is drawn anew and when either changes
 * size. A document that fits its box draws no strip, since every mark is already on the screen.
 */
export function DocumentOverview({
  root,
  body,
  page,
}: {
  root: RefObject<HTMLElement | null>;
  body: RefObject<HTMLElement | null>;
  page: string;
}) {
  const view = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Marks | null>(null);
  // the marks as last drawn, so a re-read that finds them where they were draws nothing
  const drawn = useRef("");
  // a drag of the viewport: where the pointer went down, and the scroll it went down at
  const drag = useRef<{ y: number; top: number } | null>(null);

  const place = () => {
    const el = root.current;
    const box = view.current;
    if (!el || !box) return;
    const at = viewOf(el.clientHeight, el.scrollHeight, el.scrollTop);
    box.style.top = `${at.top}px`;
    box.style.height = `${at.height}px`;
  };

  useOnChange([page], () => {
    const el = root.current;
    const text = body.current;
    if (!el || !text) return;
    const read = () => {
      const total = el.scrollHeight;
      const height = el.clientHeight;
      // the document's own top edge, wherever it is scrolled to
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      const spansOf = (mark: string): Span[] =>
        Array.from(text.getElementsByClassName(mark), (m) => m.getBoundingClientRect())
          // a mark with no box is not drawn: one inside a folded block
          .filter((r) => r.height > 0)
          .map((r) => ({ top: r.top - origin, bottom: r.bottom - origin }));
      const gone = spansOf(GONE);
      const came = spansOf(CAME);
      const scrolls = total > height;
      const next: Marks | null =
        gone.length || came.length
          ? {
              gone: scrolls ? marksOf(gone, total, height) : [],
              came: scrolls ? marksOf(came, total, height) : [],
              scrolls,
            }
          : null;
      const key = JSON.stringify(next);
      if (key !== drawn.current) {
        drawn.current = key;
        setMarks(next);
      }
      place();
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    watch.observe(text);
    el.addEventListener("scroll", place);
    return () => {
      watch.disconnect();
      el.removeEventListener("scroll", place);
    };
  });
  // the viewport is drawn once the marks are, and stands where the document is scrolled to
  useOnChange([marks], place);

  // No strip for a page with nothing marked. With marks, the element stays while the document fits
  // its box, hidden: whether the box's own scrollbar is put away then hangs on the marks alone and
  // not on the layout, which the bar's own width would otherwise change back and forth.
  if (!marks) return null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = root.current;
    if (!el || (e.pointerType === "mouse" && e.button !== 0)) return;
    // a drag here moves the document and selects nothing
    e.preventDefault();
    const at = viewOf(el.clientHeight, el.scrollHeight, el.scrollTop);
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    // off the viewport, the press brings its middle there first, and the drag goes on from it
    if (y < at.top || y > at.top + at.height) el.scrollTop = scrollAt(y, at);
    drag.current = { y: e.clientY, top: el.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = root.current;
    const from = drag.current;
    if (!el || !from) return;
    const { ratio } = viewOf(el.clientHeight, el.scrollHeight, el.scrollTop);
    if (ratio) el.scrollTop = from.top + (e.clientY - from.y) / ratio;
  };
  const drop = () => {
    drag.current = null;
  };
  // the strip stands outside the scroll box, so a wheel over it reaches nothing that scrolls; a
  // pinch is a wheel with ctrl held and is the window's
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || !root.current) return;
    root.current.scrollTop += e.deltaMode === 1 ? e.deltaY * WHEEL_LINE : e.deltaY;
  };

  const column = (spans: Span[], side: string) =>
    spans.map((s) => (
      <span
        key={s.top}
        className={cx("document-overview-mark", side)}
        style={{ top: s.top, height: s.bottom - s.top }}
      />
    ));
  return (
    <div
      className="document-overview"
      hidden={!marks.scrolls}
      aria-hidden
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={drop}
      onPointerCancel={drop}
      onWheel={onWheel}
    >
      {column(marks.gone, "document-overview-gone")}
      {column(marks.came, "document-overview-came")}
      <div ref={view} className="document-overview-view" />
    </div>
  );
}
