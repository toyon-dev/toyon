import { type RefObject, useEffect, useRef } from "react";

/** a finger has to travel this far before the touch is a drag, and which way it went by then decides
 * whose it is */
const SLOP = 8;
/** one rung of the ladder: how far the row slides for each verb. Enough that the longest word
 * and its glyph stand whole in the cell before the rung is reached, and short enough that a thumb
 * reaches the first rung without thinking about it; a list with longer words names its own. */
export const STEP = 104;
/** past the last rung the row keeps coming, but slowly: the hand reads that there is nothing further */
const GIVE = 0.25;
/** the drop back, in the stylesheet too; a verb that asks a question waits for it, so the row is
 * at rest when the question comes */
export const SETTLE_MS = 220;

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
export function slideAt(dx: number, rungs: number, rung = STEP): { step: number; x: number } {
  const d = Math.max(0, -dx);
  const reach = rungs * rung;
  const step = Math.min(rungs, Math.floor(d / rung));
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
  /** how far apart they are, for a ladder whose words need more than STEP */
  rung?: number;
};

export type SlideHandlers = {
  /** the row a touch is on, or null for a touch that is nobody's */
  rowOf: (target: Element) => SlideRow | null;
  /** the rung the finger is on changed; null once the row is back at rest */
  onSlide: (at: { key: string; step: number } | null) => void;
  /** let go on a rung, as the row starts back: what opens beside the row opens now, and what asks
   * a question waits SETTLE_MS for the row to be at rest */
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
      if (at > 0) h.current.onPick(r.key, at);
      timer = window.setTimeout(() => {
        rest(r);
        h.current.onSlide(null);
      }, SETTLE_MS);
    };
    /** the pointer a slide began with; a second finger is a pinch and ends it */
    let pointer: number | null = null;
    // Pointer events and not touch ones: the phone frame is also worked on from a desktop
    // browser at a narrow width, where the gesture is a mouse's, and the preview beside the
    // chat is one such. The list keeps the browser's vertical scroll through `touch-action:
    // pan-y` on the row's wrapper (rail.css): a finger that moves along the row is left to the
    // pointer events, and one that moves up or down becomes the scroll, which cancels them.
    const onStart = (e: PointerEvent) => {
      if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return drop();
      const r = e.target instanceof Element ? h.current.rowOf(e.target) : null;
      // a row still dropping back is not taken again: its settle would be cut, and the verb it
      // was let go on is about to run
      if (!r || r.el.dataset.slide) return;
      window.clearTimeout(timer);
      row = r;
      pointer = e.pointerId;
      from = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent) => {
      const r = row;
      if (!r || !from || e.pointerId !== pointer) return;
      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      if (!dragging) {
        const axis = slideAxis({ dx, dy });
        if (axis === "other") {
          row = null;
          from = null;
          pointer = null;
        }
        if (axis !== "slide") return;
        dragging = true;
        // a mouse dragged off the list, or out of the window, still lets go on this row
        try {
          r.el.setPointerCapture(e.pointerId);
        } catch {
          // the pointer is already gone (a touch the browser took for the scroll), and its cancel is on its way
        }
        h.current.onSlide({ key: r.key, step: 0 });
      }
      const at = slideAt(dx, r.rungs, r.rung);
      put(r, at.x, "drag");
      if (at.step !== step) {
        step = at.step;
        h.current.onSlide({ key: r.key, step });
        // a tick under the thumb at each rung, where the phone has one to give
        if (step > 0) navigator.vibrate?.(8);
      }
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (dragging) spentUntil = e.timeStamp + 400;
      pointer = null;
      drop();
    };
    // the click arrives after the pointer is let go, on the row the drag began on; swallowed
    // before the row hears it, since a slide that also opened the row would be two answers to
    // one gesture
    const onClick = (e: MouseEvent) => {
      if (e.timeStamp >= spentUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("pointerdown", onStart);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onEnd);
    el.addEventListener("pointercancel", onEnd);
    el.addEventListener("click", onClick, true);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("pointerdown", onStart);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
      el.removeEventListener("click", onClick, true);
    };
  }, [list]);
}
