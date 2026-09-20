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

/** A surface with no focus seat of its own: a click on its text drops focus on the body, and the
 * chord arrives at the window with nothing saying where the hand is. The last press says: while
 * it landed inside `ref` and nothing has taken the keyboard since, select-all means this surface. */
export function useSelectAllWithin(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let pointed = false;
    const onDown = (e: PointerEvent) => {
      pointed = !!ref.current && e.target instanceof Node && ref.current.contains(e.target);
    };
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!pointed || !el || !isSelectAll(e)) return;
      const held = document.activeElement;
      if (held && held !== document.body && !el.contains(held)) return;
      e.preventDefault();
      selectContents(el);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref]);
}

export function selectContents(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
