import { type RefObject, useEffect, useRef } from "react";

/** a finger has to travel this far before the touch is a drag, and which way it went by then decides
 * whose it is */
const SLOP = 8;
/** px per ms at the moment of letting go, over the last stretch of the drag: a throw, which takes
 * the thing away. Slower than that it is being put down, and it drops back where it was. */
const FLING = 0.7;
/** how much of the drag's tail the speed is read from: long enough to smooth the finger, short
 * enough that a drag that stopped and let go reads as stopped */
const TAIL_MS = 100;
/** a press held longer than this is a long press, which is the menu's */
const TAP_MS = 400;
/** the drop back, in the stylesheet too */
const SETTLE_MS = 260;
/** the throw plays at the finger's own speed, within reason */
const LEAVE_MIN_MS = 120;
const LEAVE_MAX_MS = 320;

export type Touch1 = { dx: number; dy: number };
export type Sample = { y: number; t: number };

/** What a touch that has travelled this far is: the swipe that takes the thing away, somebody
 * else's (the edge swipe back runs sideways), or nothing yet. */
export function swipeAxis({ dx, dy }: Touch1): "away" | "other" | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  return Math.abs(dy) > Math.abs(dx) ? "away" : "other";
}

/** The finger's speed as it let go, px per ms, signed by direction: read over the tail of the
 * drag, so a finger that stopped and then lifted is going nowhere however far it came. */
export function releaseSpeed(samples: Sample[], now: number): number {
  const tail = samples.filter((s) => now - s.t <= TAIL_MS);
  const first = tail[0];
  const last = tail[tail.length - 1];
  if (!first || !last || last.t === first.t) return 0;
  return (last.y - first.y) / (last.t - first.t);
}

/** Whether a drag let go at this speed is a throw. */
export const flung = (speed: number): boolean => Math.abs(speed) >= FLING;

/** How long the throw takes to carry the thing the rest of the way off, at the speed it was let go. */
export function leaveMs(remaining: number, speed: number): number {
  return Math.min(LEAVE_MAX_MS, Math.max(LEAVE_MIN_MS, remaining / Math.abs(speed)));
}

/**
 * A full-window box a finger can throw away: dragged up or down, what it shows follows, and thrown
 * it flies off and the box closes; put down, however far along, it drops back. The speed decides
 * and not the distance, so a slow drag to the edge is a look and a flick is a dismissal. A tap on
 * the thing itself closes it too, because at a phone's width a picture leaves no scrim beside it
 * to press.
 *
 * Only a touch that starts on something `grip` matches, or on the box's own scrim, is taken: text
 * in the box scrolls and selects under a finger. And only at the window's own scale, since on a
 * pinch-zoomed window one finger pans the view.
 *
 * The box is told through `--swipe-y`, `--swipe-fade` (0 to 1), `--swipe-ms` and `data-swipe`
 * (`drag`, `settle`, `leave`), written to the node so a drag renders nothing; its stylesheet draws
 * them.
 */
export function useSwipeAway(box: RefObject<HTMLElement | null>, grip: string, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let from: { x: number; y: number; at: number } | null = null;
    let dragging = false;
    let samples: Sample[] = [];
    let timer = 0;
    const put = (y: number, state: "drag" | "settle" | "leave", ms?: number) => {
      el.style.setProperty("--swipe-y", `${y}px`);
      el.style.setProperty("--swipe-fade", `${Math.min(1, Math.abs(y) / (window.innerHeight / 2))}`);
      if (ms !== undefined) el.style.setProperty("--swipe-ms", `${ms}ms`);
      el.dataset.swipe = state;
    };
    const rest = () => {
      el.style.removeProperty("--swipe-y");
      el.style.removeProperty("--swipe-fade");
      el.style.removeProperty("--swipe-ms");
      delete el.dataset.swipe;
    };
    const drop = () => {
      const was = dragging;
      from = null;
      dragging = false;
      samples = [];
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
      samples = [{ y: t.clientY, t: e.timeStamp }];
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
      samples.push({ y: t.clientY, t: e.timeStamp });
      if (samples.length > 16) samples.shift();
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
      const speed = releaseSpeed(samples, e.timeStamp);
      if (!dragging || !flung(speed)) return drop();
      from = null;
      dragging = false;
      samples = [];
      // off the edge the finger was heading for, at the finger's speed; the picture is at most the
      // window tall, so a window's height past where it started clears it
      const to = Math.sign(speed) * window.innerHeight;
      const wait = leaveMs(Math.abs(to - dy), speed);
      put(to, "leave", wait);
      timer = window.setTimeout(() => close.current(), wait);
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
