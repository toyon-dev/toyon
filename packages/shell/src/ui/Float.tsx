import {
  type HTMLAttributes,
  type MutableRefObject,
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "./cx.ts";
import "./float.css";
import { type DismissReason, floats } from "./floats.ts";
import { useOnChange } from "./hooks.ts";
import { type Placement, place, type Rect, widthFor } from "./place.ts";

/**
 * A box that covers what it does not own: a menu, a tooltip, a picker's panel, the toast.
 *
 * It renders in the browser's top layer (`popover`), which is above every stacking context and
 * outside every scroll box, so a float has no z-index and nothing an ancestor does can trap or clip
 * it. The one shown last is on top, which is the order they were asked for: a menu opened from a
 * picker row is above that picker, and a tip about a menu row is above both.
 *
 * The element stays where React renders it, so a surface's rules for its own float (`.bar-route
 * .overlay-box`, `.chip-picker > .overlay-box`) still match. Only the position is ours, written to
 * the node from `place()`.
 *
 * A float's dismissal is fixed for its life: to open a menu about another row, render a new Float
 * (key it by what it is about) rather than change this one's props. Layout effects inside the box
 * run before it is shown, so nothing in a child may measure itself against the window.
 */

export type FloatAnchor = "parent" | (() => Rect | null);
export type FloatHandle = { update: () => void };

type Props = Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  className: string;
  /** what it is placed against: the wrapper it sits in, or a rect it reads itself (a pointer, a
   * row's box). Absent when its own stylesheet places it against the window, as the toast does. */
  anchor?: FloatAnchor;
  placement?: Placement;
  /** a selector for the part of the box that lands on the anchor in a cover placement: the panel's
   * own field, so the value under it does not move when the panel opens over it */
  coverBy?: string;
  /** follow the anchor while it moves (a bar that re-centres, a dock being dragged); on by default
   * for a float anchored to its wrapper */
  track?: boolean;
  /** shown again when this changes, which puts it back on top of floats opened since */
  raiseKey?: unknown;
  onDismiss?: (why: DismissReason) => void;
  onKey?: (e: KeyboardEvent) => void;
  /** the control it opened from, when the gesture cannot say: a dropdown names its button */
  trigger?: Element | null;
  /** the element it is about, which places it in the stack without toggling it: a right-click
   * menu names its row, and a left click on that row closes the menu */
  from?: Element | null;
  boxRef?: MutableRefObject<HTMLDivElement | null>;
  handle?: Ref<FloatHandle>;
};

/** older engines without the top layer still get a placed box, one rung of the old ladder short */
const CAN_POPOVER = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

const rectOf = (el: Element | null): Rect | null => el?.getBoundingClientRect() ?? null;

/** how far the covering part sits inside the box, measured from the edge that faces the anchor:
 * the variant already applied decides which edge that is */
function coverInset(box: HTMLElement, selector: string, side: string, align: string) {
  const part = box.querySelector(selector);
  if (!part) return null;
  const b = box.getBoundingClientRect();
  const p = part.getBoundingClientRect();
  return {
    offset: side === "top" ? b.bottom - p.bottom : p.top - b.top,
    alignOffset: align === "end" ? b.right - p.right : p.left - b.left,
  };
}

export function Float({
  className,
  anchor,
  placement,
  coverBy,
  track = anchor === "parent",
  raiseKey,
  onDismiss,
  onKey,
  trigger,
  from,
  boxRef,
  handle,
  children,
  ...rest
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // the props the effects read, so none of them re-runs when a callback is rebuilt
  const live = useRef({ anchor, placement, coverBy, onDismiss, onKey, trigger, from });
  live.current = { anchor, placement, coverBy, onDismiss, onKey, trigger, from };

  const placeNow = useCallback(() => {
    const el = ref.current;
    const { anchor: a, placement: p, coverBy: cover } = live.current;
    if (!el || !a || !p) return;
    const rect = a === "parent" ? rectOf(el.parentElement) : a();
    if (!rect) return;
    const width = widthFor(rect, p);
    if (width !== undefined) el.style.width = `${width}px`;
    // twice at most: a box that turned over sits on the anchor by its other edge, and the bands
    // inside it have swapped with it, so the part that covers the anchor is measured again
    for (let pass = 0; pass < 2; pass++) {
      const inset = cover ? coverInset(el, cover, el.dataset.side ?? "", el.dataset.align ?? "") : null;
      const at = place(
        rect,
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight },
        inset ? { ...p, ...inset } : p,
      );
      el.style.left = `${at.x}px`;
      el.style.top = `${at.y}px`;
      const turned = el.dataset.side !== at.side || el.dataset.align !== at.align;
      el.dataset.side = at.side;
      el.dataset.align = at.align;
      if (!turned) break;
    }
  }, []);

  useImperativeHandle(handle, () => ({ update: placeNow }), [placeNow]);

  // shown before paint, so the box is in the top layer for the first frame rather than in the page
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (boxRef) boxRef.current = el;
    if (CAN_POPOVER) {
      el.popover = "manual";
      if (!el.matches(":popover-open")) el.showPopover();
    }
    const { onDismiss: dismiss, onKey: key, trigger: by, from: about } = live.current;
    const entry =
      dismiss || key
        ? floats.register({
            box: el,
            trigger: by,
            from: about,
            dismiss: dismiss ? (why) => live.current.onDismiss?.(why) : undefined,
            onKey: key ? (e) => live.current.onKey?.(e) : undefined,
          })
        : null;
    return () => {
      if (entry) floats.unregister(entry);
      if (boxRef) boxRef.current = null;
      if (CAN_POPOVER && el.isConnected && el.matches(":popover-open")) el.hidePopover();
    };
  }, [boxRef]);

  // every render: what is in the box decides its size, and a filtered list changes both
  useLayoutEffect(placeNow);

  // the anchor can move without resizing anything (a bar that re-centres, a dock mid-drag), and
  // neither a scroll nor a resize event says so, so this reads it while the float is up
  useLayoutEffect(() => {
    if (!track) return;
    let raf = 0;
    let seen = "";
    const tick = () => {
      const el = ref.current;
      const { anchor: a } = live.current;
      const rect = el && a ? (a === "parent" ? rectOf(el.parentElement) : a()) : null;
      if (el && rect) {
        const now = `${rect.left},${rect.top},${rect.right},${rect.bottom},${el.offsetWidth},${el.offsetHeight},${window.innerWidth},${window.innerHeight}`;
        if (now !== seen) {
          seen = now;
          placeNow();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [track, placeNow]);

  // keyed on what the float is about rather than on everything the body reads: shown again, it goes
  // back on top of whatever opened while it stood. The first run is the one that opened it.
  const raised = useRef(true);
  useOnChange([raiseKey], () => {
    if (raised.current) {
      raised.current = false;
      return;
    }
    const el = ref.current;
    if (!CAN_POPOVER || !el?.matches(":popover-open")) return;
    el.hidePopover();
    el.showPopover();
    placeNow();
  });

  return (
    <div ref={ref} className={cx("float", className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * A box that takes its place in the stack without taking the top layer: a centred palette, which
 * scrims the centre on purpose so the docks stay usable, and therefore stays in the page.
 * It still has to be in the stack, or a menu opened from one of its rows would not know whose child
 * it is, and the press that chooses from that menu would close the palette under it.
 */
export function useFloatEntry(
  box: MutableRefObject<HTMLElement | null>,
  {
    onDismiss,
    onKey,
    trigger,
  }: { onDismiss?: (why: DismissReason) => void; onKey?: (e: KeyboardEvent) => void; trigger?: Element | null } = {},
) {
  const live = useRef({ onDismiss, onKey, trigger });
  live.current = { onDismiss, onKey, trigger };
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { onDismiss: dismiss, onKey: key, trigger: from } = live.current;
    const entry = floats.register({
      box: el,
      trigger: from,
      dismiss: dismiss ? (why) => live.current.onDismiss?.(why) : undefined,
      onKey: key ? (e) => live.current.onKey?.(e) : undefined,
    });
    return () => floats.unregister(entry);
  }, [box]);
}
