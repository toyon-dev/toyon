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
 *
 * `data-tip-placement` / the third arg says where the box goes: `top`, `bottom`,
 * `left` or `right` of the anchor, or `follow` to trail the pointer. Without it
 * the box sits below. A side is a preference: the box flips to the opposite side
 * when that one has no room, and is clamped to the viewport either way. Anchors
 * wider than a couple of hundred pixels want `follow`: centred below a full-width
 * row, the box lands over the next row and far from the pointer.
 */

export type TipPlacement = "follow" | "top" | "bottom" | "left" | "right";
type Side = Exclude<TipPlacement, "follow">;

/** `detail` sits before the text in the quiet tier, for the where or the which ahead of the what:
 * a worktree's path, then its state. The two tiers keep them apart; a middot between them read as
 * one phrase, and a second line made a box twice as tall for a row the pointer sweeps through.
 * `dot` is a status dot class (`running`, `waiting`, see base.css) drawn just before the text:
 * for a tip that names a dot's state, so the colour and the word sit together even when the dot
 * itself is at the other end of the row. */
export function tip(text: string, key?: string, placement?: TipPlacement, detail?: string, dot?: string) {
  const label = detail ? `${text}, ${detail}` : text;
  return {
    "data-tip": text,
    "data-tip-key": key,
    "data-tip-placement": placement,
    "data-tip-detail": detail,
    "data-tip-dot": dot,
    "aria-label": key ? `${label} (${key})` : label,
  } as const;
}

const SHOW_DELAY = 120;
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

export type Anchor = {
  el: HTMLElement;
  text: string;
  key?: string;
  detail?: string;
  dot?: string;
  placement: TipPlacement;
};
type Point = { x: number; y: number };

/** The element's own placement; below when it names none. Nothing is guessed from the anchor's
 * size, so where a tip lands is readable off the markup. */
function placementOf(el: HTMLElement): TipPlacement {
  const p = el.dataset.tipPlacement;
  if (p === "follow" || p === "top" || p === "bottom" || p === "left" || p === "right") return p;
  return "bottom";
}

/** The preferred side if it has room, else the other side if that one does; when neither fits the
 * preference stands and the clamp below does what it can. */
function pick(want: Side, other: Side, wantFits: boolean, otherFits: boolean): Side {
  return wantFits || !otherFits ? want : other;
}

/** Place the box beside its anchor on the placed side, or off the pointer for a following one.
 * Flips to the opposite side when there is no room and clamps to the viewport either way. */
export function place(box: HTMLDivElement, anchor: Anchor, pointer: Point) {
  const r = anchor.el.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const p = anchor.placement;

  let side: Side;
  let top: number;
  let left: number;
  if (p === "left" || p === "right") {
    const leftOf = r.left - GAP - w;
    const rightOf = r.right + GAP;
    const fitsLeft = leftOf >= MARGIN;
    const fitsRight = rightOf + w <= vw - MARGIN;
    side = p === "left" ? pick("left", "right", fitsLeft, fitsRight) : pick("right", "left", fitsRight, fitsLeft);
    left = side === "left" ? leftOf : rightOf;
    top = r.top + r.height / 2 - h / 2;
  } else {
    const follow = p === "follow";
    const below = follow ? pointer.y + CURSOR_GAP : r.bottom + GAP;
    const above = follow ? pointer.y - CURSOR_GAP - h : r.top - GAP - h;
    const fitsBelow = below + h <= vh - MARGIN;
    const fitsAbove = above >= MARGIN;
    side = p === "top" ? pick("top", "bottom", fitsAbove, fitsBelow) : pick("bottom", "top", fitsBelow, fitsAbove);
    top = side === "top" ? above : below;
    // A following tip hangs off the pointer's lower right, the way a cursor tip always has, and
    // swaps to its left when the right runs out. Centring it on the pointer put the arrow over the
    // middle of a box that can be three hundred pixels wide, with the text going both ways from it.
    left = follow ? pointer.x + CURSOR_NUDGE : r.left + r.width / 2 - w / 2;
    if (follow && left + w > vw - MARGIN) left = pointer.x - CURSOR_NUDGE - w;
  }

  box.style.top = `${Math.round(Math.min(Math.max(MARGIN, top), vh - MARGIN - h))}px`;
  box.style.left = `${Math.round(Math.min(Math.max(MARGIN, left), vw - MARGIN - w))}px`;
  box.dataset.side = side;
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
    const show = (el: HTMLElement, placement: TipPlacement) => {
      const text = el.dataset.tip;
      if (!text) return hide();
      stopTimers();
      visible = true;
      setAnchor({
        el,
        text,
        key: el.dataset.tipKey,
        detail: el.dataset.tipDetail,
        dot: el.dataset.tipDot,
        placement,
      });
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
      const placement = placementOf(el);
      // one box already up: move it rather than tear it down and animate a new one in
      if (visible || Date.now() - lastHidden < WARM_MS) return show(el, placement);
      showTimer = window.setTimeout(() => show(el, placement), SHOW_DELAY);
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
        // reached by keyboard: there is no pointer to sit near, so a following tip anchors instead
        const placement = placementOf(el);
        show(el, placement === "follow" ? "bottom" : placement);
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
    if (anchor?.placement !== "follow") return;
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
      {anchor.detail && <span className="tooltip-detail">{anchor.detail}</span>}
      {anchor.dot && <span className={`dot ${anchor.dot} tooltip-dot`} />}
      {anchor.text}
      {anchor.key && <Kbd k={anchor.key} className="tooltip-key" />}
    </div>,
    document.body,
  );
}
