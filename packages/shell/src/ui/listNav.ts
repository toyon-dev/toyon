// The keyboard and selection machinery behind a list of rows: which one is highlighted, how ↑↓
// move it, what enter picks. ListPicker drives it from its own input; the composer's inline
// picker drives it from the textarea the caret is already in, which is why this is a hook rather
// than part of the component - the two differ in where the query lives and who holds focus, not
// in how the list behaves.

import { type RefObject, useRef, useState } from "react";
import { useOnChange } from "./hooks.ts";

/** ↑↓ with wrap-around */
export function step(i: number, delta: number, n: number): number {
  return n === 0 ? 0 : (i + delta + n) % n;
}

/** the tail of what the active row would complete `q` to, or null. A case-insensitive match must
 * not repaint the typed part, so this is only ever the part past what was typed. */
export function ghostOf(completion: string | null | undefined, q: string): string | null {
  return completion && completion.length > q.length && completion.toLowerCase().startsWith(q.toLowerCase())
    ? completion.slice(q.length)
    : null;
}

export interface ListNav<T> {
  /** already clamped: results can shrink under the highlight when the source is async */
  index: number;
  active: T | null;
  ghost: string | null;
  setIndex: (i: number) => void;
  /** runs narrowTo first, so a row that only narrows the query does not end the picker */
  pick: (t: T) => void;
  /** true when it handled the key and called preventDefault, so a host can fall through */
  onKeyDown: (e: { key: string; preventDefault: () => void }) => boolean;
}

export function useListNav<T>(opts: {
  results: T[];
  keyOf: (t: T) => string;
  q: string;
  onPick: (t: T, q: string) => void;
  /** where the rows are, so the active one can be scrolled into view */
  listRef: RefObject<HTMLElement | null>;
  onActive?: (t: T | null) => void;
  onSide?: (t: T, dir: -1 | 1) => void;
  completionOf?: (t: T, q: string) => string | null;
  narrowTo?: (t: T, q: string) => string | null;
  setQ?: (q: string) => void;
  initialIndex?: (results: T[]) => number;
  /** tab picks the row instead of completing the query: for a host with no ghost to align to */
  tabPicks?: boolean;
}): ListNav<T> {
  const { results, keyOf, q, onPick, listRef, onActive, onSide, completionOf, narrowTo, setQ, tabPicks } = opts;
  const [idx, setIdx] = useState(() => Math.max(0, opts.initialIndex?.(results) ?? 0));
  // keyed on the row's key, not the results array: parents rebuild items every render, and a
  // re-report on identity change would reset any state they keep for the active row (←→ peek)
  const activeKey = results[idx] ? keyOf(results[idx]!) : null;
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  useOnChange([activeKey], () => {
    listRef.current
      ?.querySelector<HTMLElement>('.picker-item[data-state~="cursor"]')
      ?.scrollIntoView({ block: "nearest" });
    onActiveRef.current?.(results[idx] ?? null);
  });

  const clamped = Math.min(idx, Math.max(0, results.length - 1));
  const active = results[clamped] ?? null;
  const ghost = active ? ghostOf(completionOf?.(active, q), q) : null;

  const pick = (t: T) => {
    const next = narrowTo?.(t, q);
    if (next == null) return onPick(t, q);
    setQ?.(next);
    setIdx(0);
  };

  const onKeyDown = (e: { key: string; preventDefault: () => void }): boolean => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx(step(clamped, 1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx(step(clamped, -1, results.length));
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && onSide && active) {
      e.preventDefault();
      onSide(active, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "Tab" && ghost) {
      // tab completes without picking: the point is to keep narrowing
      e.preventDefault();
      setQ?.(q + ghost);
      setIdx(0);
    } else if (e.key === "Tab" && tabPicks && active) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      pick(active);
    } else {
      return false;
    }
    return true;
  };

  return { index: clamped, active, ghost, setIndex: setIdx, pick, onKeyDown };
}
