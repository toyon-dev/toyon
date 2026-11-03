import { type RefObject, useEffect, useRef } from "react";
import { flung, leaveMs, releaseSpeed, type Sample, swipeAxis } from "./swipeAway.ts";
import {
  about,
  type Bounds,
  clampTo,
  maxScale,
  PINCH_MIN,
  type Pt,
  REST,
  resting,
  settled,
  tapZoom,
  type Zoom,
} from "./zoom.ts";

/** a press held longer than this is a long press, which is the menu's */
const TAP_MS = 400;
/** a second tap within this of the first, and this near it, makes the two a double tap; so a
 * single tap waits this long before it is one */
const DOUBLE_MS = 300;
const DOUBLE_SLOP = 32;
/** the drop back, and the zoom's settle, in the stylesheet too */
const SETTLE_MS = 260;
/** how much a wheel notch zooms: a trackpad pinch arrives as many small notches, a mouse wheel as
 * a few of a hundred, and the exponent keeps either smooth and the same both ways */
const WHEEL_ZOOM = 0.01;

/** what the picture is measured against as it stands now: its resting centre in the window, and
 * the bounds it is held within */
type Frame = { centre: Pt; bounds: Bounds };

const dist = (a: Touch, b: Touch) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
const mid = (a: Touch, b: Touch): Pt => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
const rel = (p: Pt, c: Pt): Pt => ({ x: p.x - c.x, y: p.y - c.y });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A full-window box with a picture in it, under a hand.
 *
 * At rest, a finger can throw it away: dragged up or down, the picture follows, and thrown it
 * flies off and the box closes; put down, however far along, it drops back. The speed decides and
 * not the distance, so a slow drag to the edge is a look and a flick is a dismissal. A tap on the
 * picture closes it too, because at a phone's width it leaves no scrim beside it to press.
 *
 * Two fingers pinch the picture itself, not the page: it zooms between them and stays there when
 * they lift, or comes back to fit if they had pinched it smaller. A double tap goes in about the
 * tapped point and a second brings it back. Zoomed, one finger pans and nothing throws or closes;
 * the close button and Escape still do. A double click, and a trackpad pinch or ctrl and the
 * wheel, are the same gestures from a desk; the wheel alone pans a zoomed picture.
 *
 * Only a touch that starts on something `grip` matches, or on the box's own scrim, is taken: text
 * in the box scrolls and selects under a finger. And only at the window's own scale, since on a
 * pinch-zoomed window one finger pans the view.
 *
 * The box is told through `--swipe-y`, `--swipe-fade` (0 to 1), `--swipe-ms` and `data-swipe`
 * (`drag`, `settle`, `leave`), and `--zoom-s`, `--zoom-x`, `--zoom-y` and `data-zoom` (`settle`),
 * written to the node so a move renders nothing; its stylesheet draws them.
 */
export function useFullGestures(box: RefObject<HTMLElement | null>, grip: string, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let from: { x: number; y: number; at: number } | null = null;
    let dragging = false;
    let samples: Sample[] = [];
    let timer = 0;
    let zoom: Zoom = REST;
    /** two fingers down: how far apart and where between they began, and the zoom then */
    let pinch: { d: number; m: Pt; z: Zoom } | null = null;
    /** one finger down on a zoomed picture: the zoom when it landed */
    let pan: Zoom | null = null;
    /** the last tap, while a second could still make it a double */
    let tap: { p: Pt; t: number } | null = null;
    let tapTimer = 0;
    let zoomTimer = 0;

    // the picture's layout box is the resting one, whatever transform it wears; the float is
    // position: fixed, so its offsets are from the box
    const frame = (): Frame | null => {
      const img = el.querySelector<HTMLElement>(grip);
      if (!img) return null;
      const r = el.getBoundingClientRect();
      const w = img.offsetWidth;
      const h = img.offsetHeight;
      const natural = img instanceof HTMLImageElement ? img.naturalWidth : w;
      return {
        centre: { x: r.left + img.offsetLeft + w / 2, y: r.top + img.offsetTop + h / 2 },
        bounds: { w, h, W: el.clientWidth, H: el.clientHeight, max: maxScale(natural, w) },
      };
    };
    const put = (y: number, state: "drag" | "settle" | "leave", ms?: number) => {
      if (ms !== undefined) el.style.setProperty("--swipe-ms", `${ms}ms`);
      if (el.dataset.swipe !== state) {
        el.dataset.swipe = state;
        // the state names the transition and the value is what it plays; written in one style
        // update the move can land with no transition to play it, so the state is flushed first
        void el.offsetWidth;
      }
      el.style.setProperty("--swipe-y", `${y}px`);
      el.style.setProperty("--swipe-fade", `${Math.min(1, Math.abs(y) / (window.innerHeight / 2))}`);
    };
    const rest = () => {
      el.style.removeProperty("--swipe-y");
      el.style.removeProperty("--swipe-fade");
      el.style.removeProperty("--swipe-ms");
      delete el.dataset.swipe;
    };
    const putZoom = (z: Zoom, state?: "settle") => {
      zoom = z;
      window.clearTimeout(zoomTimer);
      if (state) {
        if (el.dataset.zoom !== state) {
          el.dataset.zoom = state;
          void el.offsetWidth;
        }
        zoomTimer = window.setTimeout(() => delete el.dataset.zoom, SETTLE_MS);
      } else delete el.dataset.zoom;
      if (resting(z)) {
        el.style.removeProperty("--zoom-s");
        el.style.removeProperty("--zoom-x");
        el.style.removeProperty("--zoom-y");
        return;
      }
      el.style.setProperty("--zoom-s", `${z.s}`);
      el.style.setProperty("--zoom-x", `${z.x}px`);
      el.style.setProperty("--zoom-y", `${z.y}px`);
    };
    const drop = () => {
      const was = dragging;
      from = null;
      dragging = false;
      samples = [];
      pinch = null;
      pan = null;
      if (!was) return;
      put(0, "settle");
      timer = window.setTimeout(rest, SETTLE_MS);
    };
    const onStart = (e: TouchEvent) => {
      const on = e.target as Element | null;
      const ours = on === el || !!on?.closest(grip);
      if ((window.visualViewport?.scale ?? 1) > 1.01) return drop();
      if (el.dataset.swipe === "leave") return;
      const a = e.touches[0];
      const b = e.touches[1];
      if (a && b && e.touches.length === 2 && ours) {
        // a second finger is a pinch, and it ends whatever the first had begun
        drop();
        window.clearTimeout(tapTimer);
        tap = null;
        pinch = { d: dist(a, b), m: mid(a, b), z: zoom };
        return;
      }
      if (e.touches.length !== 1 || !a || !ours) return drop();
      window.clearTimeout(timer);
      from = { x: a.clientX, y: a.clientY, at: e.timeStamp };
      samples = [{ y: a.clientY, t: e.timeStamp }];
      pan = resting(zoom) ? null : zoom;
    };
    const onMove = (e: TouchEvent) => {
      const a = e.touches[0];
      const b = e.touches[1];
      if (pinch && a && b) {
        // ours: without this the browser zooms the page between the fingers instead
        e.preventDefault();
        const f = frame();
        if (!f) return;
        const s = clamp((pinch.z.s * dist(a, b)) / pinch.d, PINCH_MIN, f.bounds.max);
        putZoom(clampTo(about(pinch.z, s, rel(pinch.m, f.centre), rel(mid(a, b), f.centre)), f.bounds));
        return;
      }
      if (!from || !a) return;
      const dx = a.clientX - from.x;
      const dy = a.clientY - from.y;
      if (pan) {
        e.preventDefault();
        const f = frame();
        if (f) putZoom(clampTo({ s: pan.s, x: pan.x + dx, y: pan.y + dy }, f.bounds));
        return;
      }
      if (!dragging) {
        const axis = swipeAxis({ dx, dy });
        if (axis === "other") from = null;
        if (axis !== "away") return;
        dragging = true;
      }
      // ours now: without this the page under the box rubber-bands along with it
      e.preventDefault();
      samples.push({ y: a.clientY, t: e.timeStamp });
      if (samples.length > 16) samples.shift();
      put(dy, "drag");
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        if (e.touches.length >= 2) return;
        const f = frame();
        putZoom(f ? settled(zoom, f.bounds) : REST, "settle");
        pinch = null;
        // the finger still down carries the picture on from here
        const a = e.touches[0];
        if (a && !resting(zoom)) {
          from = { x: a.clientX, y: a.clientY, at: e.timeStamp };
          pan = zoom;
        }
        return;
      }
      const t = e.changedTouches[0];
      if (!from || !t) return;
      const p = { x: t.clientX, y: t.clientY };
      const dy = p.y - from.y;
      const ms = e.timeStamp - from.at;
      const tapped = !dragging && ms < TAP_MS && e.target !== el && swipeAxis({ dx: p.x - from.x, dy }) === null;
      if (tapped) {
        // the click this touch would become is spent here, and the double click with it
        e.preventDefault();
        from = null;
        pan = null;
        if (tap && e.timeStamp - tap.t < DOUBLE_MS && Math.hypot(p.x - tap.p.x, p.y - tap.p.y) < DOUBLE_SLOP) {
          window.clearTimeout(tapTimer);
          tap = null;
          const f = frame();
          putZoom(f ? tapZoom(zoom, rel(p, f.centre), f.bounds) : REST, "settle");
          return;
        }
        tap = { p, t: e.timeStamp };
        // a tap at rest closes, once it is clear no second is coming to make it a zoom
        if (resting(zoom)) tapTimer = window.setTimeout(() => close.current(), DOUBLE_MS);
        return;
      }
      if (pan) {
        pan = null;
        from = null;
        samples = [];
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
    const onDouble = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest(grip)) return;
      const f = frame();
      if (f) putZoom(tapZoom(zoom, rel({ x: e.clientX, y: e.clientY }, f.centre), f.bounds), "settle");
    };
    const onWheel = (e: WheelEvent) => {
      const f = frame();
      if (!f) return;
      // a trackpad pinch arrives as a wheel with ctrl held (Chromium, Gecko), and ctrl with the
      // wheel is the same ask from a mouse; taken here so the browser does not zoom the page
      if (e.ctrlKey) {
        e.preventDefault();
        const p = rel({ x: e.clientX, y: e.clientY }, f.centre);
        const s = clamp(zoom.s * Math.exp(-e.deltaY * WHEEL_ZOOM), 1, f.bounds.max);
        putZoom(clampTo(about(zoom, s, p, p), f.bounds));
      } else if (!resting(zoom)) {
        e.preventDefault();
        putZoom(clampTo({ s: zoom.s, x: zoom.x - e.deltaX, y: zoom.y - e.deltaY }, f.bounds));
      }
    };
    // WebKit reports a trackpad pinch as its own gesture events, with the scale since the gesture
    // began, and zooms the page unless they are taken. On iOS they come beside the touches, which
    // are already handling the pinch, so they are left alone there.
    let gesture: { z: Zoom; p: Pt } | null = null;
    const onGestureStart = (e: Event) => {
      if (pinch) return;
      e.preventDefault();
      const f = frame();
      const g = e as Event & { clientX: number; clientY: number };
      if (f) gesture = { z: zoom, p: rel({ x: g.clientX, y: g.clientY }, f.centre) };
    };
    const onGestureChange = (e: Event) => {
      if (pinch) return;
      e.preventDefault();
      const f = frame();
      if (!gesture || !f) return;
      const s = clamp(gesture.z.s * (e as Event & { scale: number }).scale, PINCH_MIN, f.bounds.max);
      putZoom(clampTo(about(gesture.z, s, gesture.p, gesture.p), f.bounds));
    };
    const onGestureEnd = (e: Event) => {
      if (pinch) return;
      e.preventDefault();
      gesture = null;
      const f = frame();
      putZoom(f ? settled(zoom, f.bounds) : REST, "settle");
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", drop);
    el.addEventListener("dblclick", onDouble);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(tapTimer);
      window.clearTimeout(zoomTimer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", drop);
      el.removeEventListener("dblclick", onDouble);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [box, grip]);
}
