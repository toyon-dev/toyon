import { type RefObject, useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { FLICK, lifted, type Sample, SLOP, type Touch1 } from "./slide.ts";

/** which way the finger is moving: left pulls in what stands to the right of the screen */
export type Way = "left" | "right";
/** the fraction of the width past which a let-go goes through */
export const COMMIT = 1 / 3;
/** the settle, in the stylesheet too (phone.css) */
export const SETTLE_MS = 220;

/** What a touch that has travelled this far is: a swipe one way or the other, somebody else's (the
 * scroll runs up and down), or nothing yet. */
export function swipeWay({ dx, dy }: Touch1): Way | "other" | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  if (Math.abs(dx) <= Math.abs(dy)) return "other";
  return dx < 0 ? "left" : "right";
}

/** Where a finger `dx` along the screen has brought the track: it follows the finger from 0 toward
 * a full width the swipe's way and no further (the neighbour is then fully in), and not back past 0
 * (there is nothing mounted the other way). */
export function swipeAt(dx: number, width: number, way: Way): number {
  return way === "left" ? Math.min(0, Math.max(-width, dx)) : Math.max(0, Math.min(width, dx));
}

/** Whether letting go at `x` goes through. A flick the swipe's way does, wherever the finger was;
 * a flick back does not, however far it had come; put down, it is where it stands: past COMMIT of
 * the width or not. `speed` is `lifted`'s, signed. */
export function swipeLetGo(x: number, width: number, way: Way, speed: number): boolean {
  const toward = way === "left" ? -speed : speed;
  if (toward >= FLICK) return true;
  if (toward <= -FLICK) return false;
  return Math.abs(x) >= width * COMMIT;
}

/** The nearest box around `target`, below `root`, that scrolls sideways: it has the sideways
 * overflow to scroll and more content than width. */
export function sideways(target: Element, root: Element): HTMLElement | null {
  for (let el = target; el !== root && el instanceof HTMLElement; el = el.parentElement as Element) {
    const overflow = getComputedStyle(el).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollWidth > el.clientWidth + 1) return el;
  }
  return null;
}

/** one finger on a frame inside the column, as its bridge reports it: in the frame's own
 * coordinates, which move with the frame */
export type FrameTouch = { phase: "start" | "move" | "end" | "cancel"; x: number; y: number };

/** the pointer id a drag fed from a frame runs under; a pointer's own ids are never negative */
const FRAME = -1;

export type SwipeHandlers = {
  /** the first move decided a way: mount what stands beside the screen that way and name the
   * track that slides for it, or say there is nothing, in which case the touch is let go */
  take: (target: Element, way: Way) => HTMLElement | null;
  /** the finger let go and the track is settling: in, when the swipe went through, or back. Said
   * at once, so what else moves with the screen (the control's pill) sets off with the settle
   * rather than after it. */
  onSettle?: (went: boolean) => void;
  /** the track is at rest again: the swipe went through (the screen is to change), or dropped back.
   * Called inside a flushSync, so the screen the frame draws for the answer lands in the same
   * frame as the track's reset. */
  onEnd: (went: boolean) => void;
};

/**
 * A column of screens a finger slides between: the one on screen moves out under the finger and
 * its neighbour comes in beside it, edge to edge, and letting go past a third of the width or in a
 * flick settles the neighbour in; short of that the screen drops back. One screen per swipe.
 *
 * Touch and pen only: a mouse dragged sideways across a transcript selects it. A touch that
 * starts in a field, a frame, a float, or on a pinched window is nobody's here, and one that moves
 * up or down is the scroll's. A touch that starts in a box that scrolls sideways (a tool block, a
 * table, a tab strip) scrolls that box by hand and never the track: on engines that stop the
 * touch-action chain at the nearest scroller (Chrome, Gecko) the browser has taken such a drag
 * natively and cancelled the pointer before this is reached, and on WebKit, which intersects
 * touch-action all the way up and so lets the screen's `pan-y` reach the box, this is what keeps
 * the box scrollable, without inertia. Whose a touch moving out of a row that slides on its own is
 * (the row's ladder, or the track's) is `take`'s to say, by the target it is handed.
 *
 * A finger on an app's frame in the column is never seen here: the frame keeps every touch that
 * starts on it. Its bridge reports the ones the app leaves alone (FrameTouch), and the function
 * returned feeds them in as the same drag, with one correction: the frame slides with the track,
 * so a finger still on the screen reads as moving the other way inside it, and the track's own
 * offset is added back.
 *
 * The track is `take`'s to name per drag, since a frame may keep more than one (a page that slides
 * whole, and a strip of faces that slides under a bar that stays). It is moved through its own
 * `translate` and told its state through `data-swipe` (`drag`, `settle`), written to the node so a
 * move renders nothing; the stylesheet draws the settle. Written as the property and not a custom
 * one, because a custom property inherits, and a track inside a track would slide twice. The
 * neighbour is mounted by the frame when `take` says a way, and unmounted or made the screen when
 * `onEnd` says how the swipe ended.
 */
export function useSwipe(root: RefObject<HTMLElement | null>, handlers: SwipeHandlers): (touch: FrameTouch) => void {
  const h = useRef(handlers);
  h.current = handlers;
  const feed = useRef<(touch: FrameTouch) => void>(() => {});
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let from: { x: number; y: number } | null = null;
    let target: Element | null = null;
    /** a box that scrolls sideways the touch began in; the drag is its */
    let box: HTMLElement | null = null;
    let scrolling = false;
    let lastX = 0;
    /** the swipe's way once the track is being dragged */
    let way: Way | null = null;
    /** the track `take` named for this drag; it stays through the settle */
    let track: HTMLElement | null = null;
    let x = 0;
    let pointer: number | null = null;
    let trail: Sample[] = [];
    let timer = 0;
    /** the click a drag's touch becomes is spent on the drag */
    let spentUntil = 0;
    const put = (at: number, state: "drag" | "settle") => {
      const t = track;
      if (!t) return;
      if (t.dataset.swipe !== state) {
        t.dataset.swipe = state;
        // the state names the transition and the value is what it plays; written in one style
        // update the move can land with no transition to play it, so the state is flushed first
        void t.offsetWidth;
      }
      t.style.translate = `${at}px`;
    };
    const rest = () => {
      const t = track;
      track = null;
      if (!t) return;
      // the attribute goes first and is flushed, so the reset itself plays no transition
      delete t.dataset.swipe;
      void t.offsetWidth;
      t.style.removeProperty("translate");
    };
    const clear = () => {
      from = null;
      target = null;
      box = null;
      scrolling = false;
      way = null;
      x = 0;
      pointer = null;
      trail = [];
    };
    const capture = (e: PointerEvent) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone (a touch the browser took for the scroll), and its cancel is on its way
      }
    };
    /** the drag is over: the track settles in or back, and once at rest the frame is told */
    const settle = (went: boolean) => {
      const w = way;
      const width = track?.clientWidth ?? 0;
      clear();
      if (!w) return;
      put(went ? (w === "left" ? -width : width) : 0, "settle");
      h.current.onSettle?.(went);
      timer = window.setTimeout(() => {
        flushSync(() => h.current.onEnd(went));
        rest();
      }, SETTLE_MS);
    };
    const onStart = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      // a second finger is a pinch, and it ends whatever the first had begun
      if (!e.isPrimary) return way ? settle(false) : clear();
      // a settle still playing is not taken again; a pinched window pans with one finger
      if (track || (window.visualViewport?.scale ?? 1) > 1.01) return;
      const on = e.target instanceof Element ? e.target : null;
      if (!on || on.closest("textarea, input, [contenteditable], iframe, .float")) return;
      window.clearTimeout(timer);
      from = { x: e.clientX, y: e.clientY };
      target = on;
      box = sideways(on, el);
      pointer = e.pointerId;
      lastX = e.clientX;
    };
    /** one move of the finger, the pointer's own or a frame's: `e` is the pointer's, for capture */
    const move = (cx: number, cy: number, t: number, e?: PointerEvent) => {
      if (!from || !target) return;
      const dx = cx - from.x;
      const dy = cy - from.y;
      if (scrolling && box) {
        box.scrollLeft -= cx - lastX;
        lastX = cx;
        return;
      }
      if (!way) {
        const w = swipeWay({ dx, dy });
        if (w === null) return;
        if (w === "other") return clear();
        if (box) {
          scrolling = true;
          lastX = cx;
          if (e) capture(e);
          return;
        }
        const t = h.current.take(target, w);
        if (!t) return clear();
        track = t;
        way = w;
        if (e) capture(e);
      }
      trail.push({ x: cx, t });
      if (trail.length > 8) trail.shift();
      x = swipeAt(dx, track?.clientWidth ?? 0, way);
      put(x, "drag");
    };
    /** the finger lifted (`up`), or the browser took it */
    const end = (t: number, up: boolean) => {
      if (!way) return clear();
      const width = track?.clientWidth ?? 0;
      const speed = up ? lifted(trail, t) : 0;
      const went = up && swipeLetGo(x, width, way, speed);
      // a flick that went is a tick under the thumb, as a row's rung is
      if (went && Math.abs(x) < width * COMMIT) navigator.vibrate?.(8);
      settle(went);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      move(e.clientX, e.clientY, e.timeStamp, e);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (way || scrolling) spentUntil = e.timeStamp + 400;
      end(e.timeStamp, e.type === "pointerup");
    };
    feed.current = (touch) => {
      const now = performance.now();
      if (touch.phase === "start") {
        // a settle still playing, or a pointer's own drag under way, is not taken again
        if (track || from) return;
        from = { x: touch.x, y: touch.y };
        target = el;
        box = null;
        pointer = FRAME;
        return;
      }
      if (pointer !== FRAME) return;
      if (touch.phase === "move") return move(touch.x + x, touch.y, now);
      end(now, touch.phase === "end");
    };
    // the click arrives after the pointer is let go, on whatever the drag began on; swallowed
    // before it hears it, since a swipe that also pressed a row would be two answers to one touch
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
      feed.current = () => {};
      window.clearTimeout(timer);
      el.removeEventListener("pointerdown", onStart);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
      el.removeEventListener("click", onClick, true);
    };
  }, [root]);
  return useCallback((touch: FrameTouch) => feed.current(touch), []);
}
