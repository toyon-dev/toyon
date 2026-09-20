import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTouch } from "../state/selectors.ts";
import { Float, type FloatHandle } from "./Float.tsx";
import { Kbd } from "./Kbd.tsx";
import { type Placement, type Point, pointRect, type Rect } from "./place.ts";
import { Spinner } from "./Spinner.tsx";
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

export type TipOptions = {
  placement?: TipPlacement;
  /** a second line under the text in the quiet tier, for the where or the which under the what:
   * a worktree's state, then its path. The text is what you asked, so it comes first; a middot
   * between the two on one line read as a phrase, and the path ahead of the state put the answer
   * last. */
  detail?: string;
  /** a status dot class (`running`, `waiting`, see base.css) drawn just before the text: for a
   * tip that names a dot's state, so the colour and the word sit together even when the dot
   * itself is at the other end of the row. `spinner` draws the Spinner's dot instead, for a tip
   * whose row has swapped its dot for one while an op runs. */
  dot?: string;
  /** a line under the text in the quiet tier, naming the thing the text is about: a worktree row's
   * branch under its state, so every row's tip has the same shape whatever the row itself shows.
   * The text is the answer and leads; the name says whose, and takes the aside on its line. */
  name?: string;
  /** the aside on the name's line, held against the box's far edge from the row, whichever edge
   * that is for the tip's placement: what this has cost, apart from what it is and what it is
   * doing. A worktree row puts its agent's spend and context here. Drawn only with a name. */
  aside?: string;
  /** the other verb of the same gesture, on a key of its own, as a row under the text in the quiet
   * tier: the inspector's button says ⌘E adds the element to chat under its own ⌘I. The two keys
   * stand in one column so the chords line up and read as a pair. A lead has no place in the grid
   * and is not drawn beside it. */
  also?: TipAlso;
};

export type TipAlso = { text: string; key: string };

export function tip(text: string, key?: string, { placement, detail, dot, name, aside, also }: TipOptions = {}) {
  const named = name ? `${text}: ${name}` : text;
  const label = [named, name ? aside : undefined, detail].filter(Boolean).join(", ");
  return {
    "data-tip": text,
    "data-tip-key": key,
    "data-tip-placement": placement,
    "data-tip-detail": detail,
    "data-tip-dot": dot,
    "data-tip-name": name,
    "data-tip-aside": aside,
    "data-tip-also": also?.text,
    "data-tip-also-key": also?.key,
    // the name stays this control's own: the other verb is a hint for the eye, not what it does
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
  name?: string;
  aside?: string;
  also?: TipAlso;
  placement: TipPlacement;
};

/** The element's own placement; below when it names none. Nothing is guessed from the anchor's
 * size, so where a tip lands is readable off the markup. */
function placementOf(el: HTMLElement): TipPlacement {
  const p = el.dataset.tipPlacement;
  if (p === "follow" || p === "top" || p === "bottom" || p === "left" || p === "right") return p;
  return "bottom";
}

/** Where a tip goes: beside its element on the side the markup asked for, or off the pointer for a
 * following one. A following tip hangs off the pointer's lower right, the way a cursor tip always
 * has, and swaps to its left when the right runs out; centring it on the pointer put the arrow over
 * the middle of a box that can be three hundred pixels wide, with the text going both ways from it.
 * A side tip centres on its anchor and never swaps ends, so only the side it grows on can turn. */
export function tipPlacement(p: TipPlacement): Placement {
  if (p === "follow") {
    return {
      side: "bottom",
      align: "start",
      offset: CURSOR_GAP,
      alignOffset: -CURSOR_NUDGE,
      flip: "both",
      margin: MARGIN,
    };
  }
  return { side: p, align: "center", offset: GAP, flip: "side", margin: MARGIN };
}

/** what the tip is placed against: its control, or the pointer it trails */
export function tipRect(anchor: Anchor, pointer: Point): Rect {
  return anchor.placement === "follow" ? pointRect(pointer) : anchor.el.getBoundingClientRect();
}

export function Tooltips() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const handle = useRef<FloatHandle | null>(null);
  const pointer = useRef<Point>({ x: 0, y: 0 });
  // A tip leaves when the pointer does. On touch there is no pointer: a tap fires the compatibility
  // mouseover and no mouseout ever follows, so a tip would come up under a thumb and stay. Nothing
  // is installed there; a row on a screen says its tip out loud instead (rowLine), and the
  // focus-visible path below still answers a keyboard attached to a tablet.
  const touch = useTouch();

  useEffect(() => {
    if (touch) return;
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
        name: el.dataset.tipName,
        aside: el.dataset.tipAside,
        also:
          el.dataset.tipAlso && el.dataset.tipAlsoKey
            ? { text: el.dataset.tipAlso, key: el.dataset.tipAlsoKey }
            : undefined,
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
  }, [touch]);

  // the control a tip is about can leave while the tip is up (a row removed under it)
  useLayoutEffect(() => {
    if (anchor && !anchor.el.isConnected) setAnchor(null);
  }, [anchor]);

  // a following tip is repositioned straight on the node: going through state would re-render the
  // whole tooltip on every mouse move
  useEffect(() => {
    if (anchor?.placement !== "follow") return;
    const onMove = (e: MouseEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      handle.current?.update();
    };
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, [anchor]);

  if (!anchor) return null;
  const words = (
    <>
      {anchor.dot === "spinner" ? (
        <Spinner size="dot" className="tooltip-dot" />
      ) : (
        anchor.dot && <span className={`dot ${anchor.dot} tooltip-dot`} />
      )}
      {anchor.text}
    </>
  );
  const head = (
    <>
      {words}
      {anchor.key && <Kbd k={anchor.key} className="tooltip-key" />}
    </>
  );
  return (
    // shown again whenever it moves to another control, which puts it back above whatever opened
    // while it stood: a tip about a menu row is over that menu
    <Float
      className="tooltip"
      role="tooltip"
      boxRef={box}
      handle={handle}
      anchor={() => tipRect(anchor, pointer.current)}
      placement={tipPlacement(anchor.placement)}
      track={false}
      raiseKey={anchor}
    >
      {anchor.also ? (
        <div className="tooltip-pair">
          <span>{words}</span>
          {anchor.key ? <Kbd k={anchor.key} className="tooltip-key" /> : <span />}
          <span className="tooltip-also">{anchor.also.text}</span>
          <Kbd k={anchor.also.key} className="tooltip-key" />
        </div>
      ) : (
        head
      )}
      {anchor.name && (
        // the name stays against the row it describes: a tip standing to the row's left ends
        // with the name and holds the aside at the far edge, which is its first
        <div className="tooltip-name">
          {anchor.placement === "left" && anchor.aside && <span className="tooltip-aside">{anchor.aside}</span>}
          <span>{anchor.name}</span>
          {anchor.placement !== "left" && anchor.aside && <span className="tooltip-aside">{anchor.aside}</span>}
        </div>
      )}
      {anchor.detail && <div className="tooltip-detail">{anchor.detail}</div>}
    </Float>
  );
}
