import { type RefObject, useEffect } from "react";

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
 * reached the window unclaimed from outside `ref`, and is handed what holds the keyboard. */
export function useKeyWithin(
  ref: RefObject<HTMLElement | null>,
  match: (e: KeyboardEvent) => boolean,
  act: (el: HTMLElement, e: KeyboardEvent) => void,
  elsewhere?: (held: Element | null) => boolean,
) {
  useEffect(() => {
    let pointed = false;
    const onDown = (e: PointerEvent) => {
      pointed = !!ref.current && e.target instanceof Node && ref.current.contains(e.target);
    };
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || e.defaultPrevented || !match(e)) return;
      const held = document.activeElement;
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
  }, [ref, match, act, elsewhere]);
}

/** select-all on a surface that is read and not edited: the surface, not the shell around it */
export function useSelectAllWithin(ref: RefObject<HTMLElement | null>) {
  useKeyWithin(ref, isSelectAll, selectContents);
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

export function selectContents(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
