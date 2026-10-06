import { type RefObject, useEffect, useRef } from "react";

/** a finger has to travel this far before the touch is a drag, and which way it went by then decides
 * whose it is */
const SLOP = 8;
/** let go this far from where it started, the thing is gone */
const AWAY = 96;
/** or sooner, thrown: px per ms, over at least this much travel */
const FLICK = 0.5;
const FLICK_MIN = 24;
/** a press held longer than this is a long press, which is the menu's */
const TAP_MS = 400;
/** the stylesheet's transition, and how long the box is left to play it */
const SETTLE_MS = 180;

export type Touch1 = { dx: number; dy: number; ms: number };

/** What a touch that has travelled this far is: the swipe that takes the thing away, somebody
 * else's (the edge swipe back runs sideways), or nothing yet. */
export function swipeAxis({ dx, dy }: Pick<Touch1, "dx" | "dy">): "away" | "other" | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  return Math.abs(dy) > Math.abs(dx) ? "away" : "other";
}

/** Whether a drag let go here takes the thing away or drops it back. */
export function swipeEnds({ dy, ms }: Pick<Touch1, "dy" | "ms">): boolean {
  const far = Math.abs(dy);
  return far >= AWAY || (far >= FLICK_MIN && far / Math.max(ms, 1) >= FLICK);
}

/**
 * A full-window box a finger can throw away: dragged up or down, what it shows follows, and let go
 * far enough (or thrown) the box closes. A tap on the thing itself closes it too, because at a
 * phone's width a picture leaves no scrim beside it to press.
 *
 * Only a touch that starts on something `grip` matches, or on the box's own scrim, is taken: text
 * in the box scrolls and selects under a finger. And only at the window's own scale, since on a
 * pinch-zoomed window one finger pans the view.
 *
 * The box is told through `--swipe-y`, `--swipe-fade` (0 to 1) and `data-swipe` (`drag`, `settle`,
 * `leave`), written to the node so a drag renders nothing; its stylesheet draws them.
 */
export function useSwipeAway(box: RefObject<HTMLElement | null>, grip: string, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let from: { x: number; y: number; at: number } | null = null;
    let dragging = false;
    let timer = 0;
    const put = (y: number, state: "drag" | "settle" | "leave") => {
      el.style.setProperty("--swipe-y", `${y}px`);
      el.style.setProperty("--swipe-fade", `${Math.min(1, Math.abs(y) / (window.innerHeight / 2))}`);
      el.dataset.swipe = state;
    };
    const rest = () => {
      el.style.removeProperty("--swipe-y");
      el.style.removeProperty("--swipe-fade");
      delete el.dataset.swipe;
    };
    const drop = () => {
      const was = dragging;
      from = null;
      dragging = false;
      if (!was) return;
      put(0, "settle");
      timer = window.setTimeout(rest, SETTLE_MS);
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const on = e.target as Element | null;
      // a second finger is a pinch, and it ends whatever the first had begun
      if (e.touches.length !== 1 || !t || (window.visualViewport?.scale ?? 1) > 1.01) return drop();
      if (el.dataset.swipe === "leave" || !(on === el || on?.closest(grip))) return;
      window.clearTimeout(timer);
      from = { x: t.clientX, y: t.clientY, at: e.timeStamp };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!from || !t) return;
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;
      if (!dragging) {
        const axis = swipeAxis({ dx, dy });
        if (axis === "other") from = null;
        if (axis !== "away") return;
        dragging = true;
      }
      // ours now: without this the page under the box rubber-bands along with it
      e.preventDefault();
      put(dy, "drag");
    };
    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!from || !t) return;
      const dy = t.clientY - from.y;
      const ms = e.timeStamp - from.at;
      const tapped = !dragging && ms < TAP_MS && e.target !== el && swipeAxis({ dx: t.clientX - from.x, dy }) === null;
      if (tapped) {
        // the click this touch would become is spent here
        e.preventDefault();
        from = null;
        close.current();
        return;
      }
      if (!dragging || !swipeEnds({ dy, ms })) return drop();
      from = null;
      dragging = false;
      put(Math.sign(dy) * window.innerHeight, "leave");
      timer = window.setTimeout(() => close.current(), SETTLE_MS);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", drop);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", drop);
    };
  }, [box, grip]);
}
