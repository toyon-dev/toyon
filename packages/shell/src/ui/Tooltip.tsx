import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd.tsx";
import "./tooltip.css";

/**
 * One tooltip for the whole app. Put `data-tip="…"` on any element (or spread
 * `tip("…", "⌘K")` on icon-only controls so they also get an accessible name;
 * `data-tip-key` / the second arg renders the shortcut set apart) and
 * mount `<Tooltips />` once at the root. Delegated: no wrappers, no per-element
 * state, works for elements rendered later. Shows on hover (after a short
 * delay) and on keyboard focus (immediately); hides on click, key, or scroll.
 */

export function tip(text: string, key?: string) {
  return { "data-tip": text, "data-tip-key": key, "aria-label": key ? `${text} (${key})` : text } as const;
}

const SHOW_DELAY = 120;
/** An anchor wider than this puts its own centre a long way from the pointer, so the tip follows
 * the pointer instead. Below it the two are within a few pixels of each other and anchoring is
 * steadier, which is what every icon button in the app wants. */
const FOLLOW_MIN_W = 120;
// after leaving a visible tooltip, the next one within this window shows
// instantly (sweeping a toolbar shouldn't re-wait on every button)
const WARM_MS = 600;
/** Leaving a tip doesn't hide it at once. List rows sit flush against each other but carry their
 * tip on the label inside them, so the pointer crosses a strip of untipped padding on the way to
 * the next one; hiding there unmounted the box and replayed its entry animation, which read as a
 * fade out and back in between two touching rows. Within this window the box stays mounted and
 * only swaps its text and position. */
const HIDE_GRACE = 150;
const GAP = 6;
/** clear of the pointer itself, which is taller than the gap a box needs from an edge */
const CURSOR_GAP = 18;
/** and off to its side, so the pointer sits near a corner of the box rather than over its text */
const CURSOR_NUDGE = 12;
const MARGIN = 8;

type Anchor = { el: HTMLElement; text: string; key?: string; follow: boolean };
type Point = { x: number; y: number };

/** Place the box under its anchor, or under the pointer for a wide one. Flips above when there is
 * no room below and clamps to the viewport either way. */
function place(box: HTMLDivElement, anchor: Anchor, pointer: Point) {
  const r = anchor.el.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const below = anchor.follow ? pointer.y + CURSOR_GAP : r.bottom + GAP;
  const above = anchor.follow ? pointer.y - CURSOR_GAP - h : r.top - GAP - h;
  const flip = below + h > vh - MARGIN && above >= MARGIN;

  // A following tip hangs off the pointer's lower right, the way a cursor tip always has, and
  // swaps to its left when the right runs out. Centring it on the pointer put the arrow over the
  // middle of a box that can be three hundred pixels wide, with the text going both ways from it.
  let left = anchor.follow ? pointer.x + CURSOR_NUDGE : r.left + r.width / 2 - w / 2;
  if (anchor.follow && left + w > vw - MARGIN) left = pointer.x - CURSOR_NUDGE - w;

  box.style.top = `${Math.round(flip ? above : below)}px`;
  box.style.left = `${Math.round(Math.min(Math.max(MARGIN, left), vw - MARGIN - w))}px`;
  box.dataset.side = flip ? "above" : "below";
}

export function Tooltips() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pointer = useRef<Point>({ x: 0, y: 0 });

  useEffect(() => {
    let showTimer = 0;
    let hideTimer = 0;
    let current: HTMLElement | null = null;
    let visible = false;
    let lastHidden = 0;

    const stopTimers = () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
    const hide = () => {
      stopTimers();
      if (visible) lastHidden = Date.now();
      visible = false;
      current = null;
      setAnchor(null);
    };
    const show = (el: HTMLElement, follow: boolean) => {
      const text = el.dataset.tip;
      if (!text) return hide();
      stopTimers();
      visible = true;
      setAnchor({ el, text, key: el.dataset.tipKey, follow });
    };
    const target = (e: Event) => {
      const t = e.target;
      return t instanceof Element ? (t.closest("[data-tip]") as HTMLElement | null) : null;
    };

    const onOver = (e: MouseEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      const el = target(e);
      if (el === current) return;
      stopTimers();
      current = el;
      if (!el) {
        if (visible) hideTimer = window.setTimeout(hide, HIDE_GRACE);
        return;
      }
      const follow = el.getBoundingClientRect().width > FOLLOW_MIN_W;
      // one box already up: move it rather than tear it down and animate a new one in
      if (visible || Date.now() - lastHidden < WARM_MS) return show(el, follow);
      showTimer = window.setTimeout(() => show(el, follow), SHOW_DELAY);
    };
    const onOut = (e: MouseEvent) => {
      // left the window entirely
      if (!e.relatedTarget) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = target(e);
      if (el?.matches(":focus-visible")) {
        stopTimers();
        current = el;
        // reached by keyboard: there is no pointer to sit near, so anchor it
        show(el, false);
      }
    };
    const onBlur = () => hide();
    /** Typing or firing a shortcut should clear the tip; holding a modifier is neither. Hiding on
     * every keydown meant reaching for ⌘ or ⇧ over a control closed the thing describing it, which
     * is exactly when you are about to use it. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") hide();
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("mousedown", hide);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    window.addEventListener("blur", hide);
    return () => {
      stopTimers();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // position after render so we can measure our own size
  useLayoutEffect(() => {
    const b = box.current;
    if (!b || !anchor) return;
    if (!anchor.el.isConnected) return setAnchor(null);
    place(b, anchor, pointer.current);
  }, [anchor]);

  // a following tip is repositioned straight on the node: going through state would re-render the
  // whole tooltip on every mouse move
  useEffect(() => {
    if (!anchor?.follow) return;
    const onMove = (e: MouseEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      if (box.current) place(box.current, anchor, pointer.current);
    };
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(
    <div ref={box} className="tooltip" role="tooltip">
      {anchor.text}
      {anchor.key && <Kbd k={anchor.key} className="tooltip-key" />}
    </div>,
    document.body,
  );
}
