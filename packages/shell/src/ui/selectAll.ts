import { type RefObject, useCallback, useEffect } from "react";

/** The browser's select-all, on a surface that is read and not edited, takes the whole shell with
 * it: the rail, the bar, every dock. A surface that is a document of its own answers the chord
 * itself with its own contents. */

export function isSelectAll(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  return e.key === "a" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** A key that means this surface while the hand is on it. The keyboard inside `ref` says so
 * outright. A surface with no focus seat of its own is the other case: a click on its text drops
 * focus on the body, and the key arrives at the window with nothing saying where the hand is. The
 * last press says: while it landed inside `ref` and nothing has taken the keyboard since, the key
 * means this surface. `act` is handed the element, and the event has been claimed.
 *
 * `elsewhere` lets the surface answer for a hand that is on none: it is asked about a key that
 * reached the window unclaimed from outside `ref`, and is handed what holds the keyboard.
 * `except` names what stands inside `ref` without being the surface (a box to type in at a
 * log's foot): a hand there keeps the browser's own answer. */
export function useKeyWithin(
  ref: RefObject<HTMLElement | null>,
  match: (e: KeyboardEvent) => boolean,
  act: (el: HTMLElement, e: KeyboardEvent) => void,
  elsewhere?: (held: Element | null) => boolean,
  except?: string,
) {
  useEffect(() => {
    let pointed = false;
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      pointed = !!ref.current && !!target && ref.current.contains(target) && !(except && target.closest(except));
    };
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || e.defaultPrevented || !match(e)) return;
      const held = document.activeElement;
      if (except && held?.closest(except)) return;
      const inside = held && held !== document.body ? el.contains(held) : pointed;
      if (!inside && !elsewhere?.(held)) return;
      e.preventDefault();
      act(el, e);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, match, act, elsewhere, except]);
}

/** What of a surface select-all takes, when not the whole of it: `upTo` names the child the
 * selection stops before, and `except` what inside the surface keeps the browser's own select-all
 * (useKeyWithin). One value for the surface's life, so the listener is set once. */
export interface SelectionScope {
  upTo?: (el: HTMLElement) => Element | null;
  except?: string;
}

/** select-all on a surface that is read and not edited: the surface, not the shell around it */
export function useSelectAllWithin(ref: RefObject<HTMLElement | null>, scope?: SelectionScope) {
  const act = useCallback((el: HTMLElement) => selectContents(el, scope?.upTo?.(el)), [scope]);
  useKeyWithin(ref, isSelectAll, act, undefined, scope?.except);
}

/** what is selected inside `el`, or null when the selection is empty, blank, or lies elsewhere.
 * Blank lines around it are the block boundaries a drag crossed, not part of what was meant. */
export function selectedText(el: Element): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!el.contains(sel.getRangeAt(0).commonAncestorContainer)) return null;
  const text = sel.toString().replace(/^\n+|\n+$/g, "");
  return text.trim() ? text : null;
}

/** the contents of `el` as the selection, stopping before `upTo` when there is one */
export function selectContents(el: Element, upTo?: Element | null) {
  const range = document.createRange();
  range.selectNodeContents(el);
  if (upTo) range.setEndBefore(upTo);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
