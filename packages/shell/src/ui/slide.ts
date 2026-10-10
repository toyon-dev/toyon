import { type RefObject, useEffect, useRef } from "react";

/** a finger has to travel this far before the touch is a drag, and which way it went by then decides
 * whose it is */
const SLOP = 8;
/** one rung of the ladder: how far the row slides for each verb. A thumb's width with room, so the
 * word under it has its box and a short drag reaches one rung and not two. */
export const STEP = 72;
/** past the last rung the row keeps coming, but slowly: the hand reads that there is nothing further */
const GIVE = 0.25;
/** the drop back, in the stylesheet too */
const SETTLE_MS = 260;

export type Touch1 = { dx: number; dy: number };

/** What a touch that has travelled this far is: the slide, which runs along the row toward its
 * start, somebody else's (the list scrolls up and down, and the edge swipe back runs the other way),
 * or nothing yet. */
export function slideAxis({ dx, dy }: Touch1): "slide" | "other" | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) && dx < 0 ? "slide" : "other";
}

/** Where a finger `dx` along the row has brought it: the rung it is on, 0 before the first, and the
 * offset the row is drawn at. The row follows the finger rung for rung and gives past the last. */
export function slideAt(dx: number, rungs: number): { step: number; x: number } {
  const d = Math.max(0, -dx);
  const reach = rungs * STEP;
  const step = Math.min(rungs, Math.floor(d / STEP));
  const x = d <= reach ? d : reach + (d - reach) * GIVE;
  return { step, x: -x };
}

/** the row a touch landed on, and what the hook needs to know about it */
export type SlideRow = {
  /** the element the slide is written to: it holds the row and the cell the row uncovers */
  el: HTMLElement;
  key: string;
  /** how many rungs the row's ladder has */
  rungs: number;
};

export type SlideHandlers = {
  /** the row a touch is on, or null for a touch that is nobody's */
  rowOf: (target: Element) => SlideRow | null;
  /** the rung the finger is on changed; null once the row is back at rest */
  onSlide: (at: { key: string; step: number } | null) => void;
  /** let go on a rung, after the row has dropped back */
  onPick: (key: string, step: number) => void;
};

/**
 * A list whose rows slide along under a finger, each uncovering a ladder of verbs one rung at a
 * time: the first rung after a short drag, the next after a longer one, and letting go does the
 * rung the finger is on. Short of the first rung, or past the last, letting go does nothing and
 * the row drops back. A tap is still a tap, and a drag up or down is still the list's scroll;
 * only a drag along the row, toward its start, is the slide's.
 *
 * The row is told through `--slide-x` and `data-slide` (`drag`, `settle`), written to the node so
 * a move renders nothing; the rung is state, since it names a word. The stylesheet draws both.
 */
export function useSlide(list: RefObject<HTMLElement | null>, handlers: SlideHandlers) {
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let row: SlideRow | null = null;
    let from: { x: number; y: number } | null = null;
    let dragging = false;
    let step = 0;
    let timer = 0;
    /** the click a drag's touch becomes is spent on the drag; a stamp rather than a flag, since
     * the click comes after the touch has ended */
    let spentUntil = 0;
    const put = (r: SlideRow, x: number, state: "drag" | "settle") => {
      if (r.el.dataset.slide !== state) {
        r.el.dataset.slide = state;
        // the state names the transition and the value is what it plays; written in one style
        // update the move can land with no transition to play it, so the state is flushed first
        void r.el.offsetWidth;
      }
      r.el.style.setProperty("--slide-x", `${x}px`);
    };
    const rest = (r: SlideRow) => {
      r.el.style.removeProperty("--slide-x");
      delete r.el.dataset.slide;
    };
    const drop = () => {
      const r = row;
      const was = dragging;
      const at = step;
      row = null;
      from = null;
      dragging = false;
      step = 0;
      if (!r || !was) return;
      put(r, 0, "settle");
      timer = window.setTimeout(() => {
        rest(r);
        h.current.onSlide(null);
        // after the drop, so a question the verb asks finds the row at rest and not mid-air
        if (at > 0) h.current.onPick(r.key, at);
      }, SETTLE_MS);
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      // a second finger is a pinch, and it ends whatever the first had begun
      if (e.touches.length !== 1 || !t) return drop();
      const r = e.target instanceof Element ? h.current.rowOf(e.target) : null;
      // a row still dropping back is not taken again: its settle would be cut, and the verb it
      // was let go on is about to run
      if (!r || r.el.dataset.slide) return;
      window.clearTimeout(timer);
      row = r;
      from = { x: t.clientX, y: t.clientY };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      const r = row;
      if (!r || !from || !t) return;
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;
      if (!dragging) {
        const axis = slideAxis({ dx, dy });
        if (axis === "other") {
          row = null;
          from = null;
        }
        if (axis !== "slide") return;
        dragging = true;
        h.current.onSlide({ key: r.key, step: 0 });
      }
      // ours now: the list must not scroll under a finger that is sliding a row
      if (e.cancelable) e.preventDefault();
      const at = slideAt(dx, r.rungs);
      put(r, at.x, "drag");
      if (at.step !== step) {
        step = at.step;
        h.current.onSlide({ key: r.key, step });
        // a tick under the thumb at each rung, where the phone has one to give
        if (step > 0) navigator.vibrate?.(8);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (dragging) spentUntil = e.timeStamp + 400;
      drop();
    };
    // the click arrives after the touch, on the row the drag began on; swallowed before the row
    // hears it, since a slide that also opened the row would be two answers to one gesture
    const onClick = (e: MouseEvent) => {
      if (e.timeStamp >= spentUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", drop);
    el.addEventListener("click", onClick, true);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", drop);
      el.removeEventListener("click", onClick, true);
    };
  }, [list]);
}
