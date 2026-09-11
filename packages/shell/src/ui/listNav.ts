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

/** ↑↓ in a list that may have nothing highlighted yet: down lands on the first row and up on the
 * last, the way an address bar's suggestions do; from a row it is `step` */
export function stepFrom(i: number, delta: number, n: number): number {
  if (i >= 0) return step(i, delta, n);
  if (n === 0) return -1;
  return delta > 0 ? 0 : n - 1;
}

/** typeahead: the next row after `from` whose label starts with `ch`, wrapping, so pressing the
 * same letter again walks the rows that share it; -1 when none does. `from` may be -1 for "no row
 * yet", which is where a menu opened with the mouse starts. */
export function jumpTo(labels: string[], from: number, ch: string): number {
  const n = labels.length;
  const c = ch.toLowerCase();
  for (let k = 1; k <= n; k++) {
    const j = (Math.max(from, -1) + k) % n;
    if (labels[j]?.trim().toLowerCase().startsWith(c)) return j;
  }
  return -1;
}

/** What a row completes the query to when that is more than tab should take: `show` is drawn after
 * the caret with `params` (ranges of it) drawn as placeholders, and tab appends only `accept`. A
 * template's parameter is shown so the shape of the path is visible, and never typed in for you. */
export type Completion = { show: string; accept: string; params?: Array<[number, number]> };

/** the ghost after the caret: the text past what was typed, the part of it tab takes (null when
 * none), and the placeholder ranges, all counted from the caret */
export type Ghost = { text: string; accept: string | null; params: Array<[number, number]> };

/** the tail of what the active row would complete `q` to, or null. A case-insensitive match must
 * not repaint the typed part, so this is only ever the part past what was typed. */
export function ghostOf(completion: string | null | undefined, q: string): string | null {
  return completion && completion.length > q.length && completion.toLowerCase().startsWith(q.toLowerCase())
    ? completion.slice(q.length)
    : null;
}

/** a completion in either shape as the ghost after the caret; null when it does not extend `q` */
export function ghostParts(completion: string | Completion | null | undefined, q: string): Ghost | null {
  if (completion == null) return null;
  if (typeof completion === "string") {
    const text = ghostOf(completion, q);
    return text ? { text, accept: text, params: [] } : null;
  }
  const text = ghostOf(completion.show, q);
  if (!text) return null;
  const params = (completion.params ?? [])
    .map(([a, b]): [number, number] => [Math.max(a, q.length) - q.length, b - q.length])
    .filter(([a, b]) => b > a);
  return { text, accept: ghostOf(completion.accept, q), params };
}

export interface ListNav<T> {
  /** already clamped: results can shrink under the highlight when the source is async. -1 while
   * an idle list has nothing highlighted. */
  index: number;
  active: T | null;
  ghost: Ghost | null;
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
  completionOf?: (t: T, q: string) => string | Completion | null;
  narrowTo?: (t: T, q: string) => string | null;
  setQ?: (q: string) => void;
  initialIndex?: (results: T[]) => number;
  /** start with no row highlighted; `setIndex(-1)` returns there. Enter then goes to `onIdlePick`. */
  idle?: boolean;
  onIdlePick?: (q: string) => void;
  /** tab picks the row instead of completing the query: for a host with no ghost to align to */
  tabPicks?: boolean;
}): ListNav<T> {
  const { results, keyOf, q, onPick, listRef, onActive, onSide, completionOf, narrowTo, setQ, tabPicks, onIdlePick } =
    opts;
  // the clamp keeps a picker whose initialIndex found nothing (-1) on its first row; only a list
  // that asked to be idle starts on none
  const [idx, setIdx] = useState(() => (opts.idle ? -1 : Math.max(0, opts.initialIndex?.(results) ?? 0)));
  // keyed on the row's key, not the results array: parents rebuild items every render, and a
  // re-report on identity change would reset any state they keep for the active row (←→ peek)
  const activeKey = idx >= 0 && results[idx] ? keyOf(results[idx]!) : null;
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  useOnChange([activeKey], () => {
    listRef.current
      ?.querySelector<HTMLElement>('.picker-item[data-state~="cursor"]')
      ?.scrollIntoView({ block: "nearest" });
    onActiveRef.current?.(idx >= 0 ? (results[idx] ?? null) : null);
  });

  const clamped = idx < 0 ? -1 : Math.min(idx, Math.max(0, results.length - 1));
  const active = clamped >= 0 ? (results[clamped] ?? null) : null;
  const ghost = active ? ghostParts(completionOf?.(active, q), q) : null;

  const pick = (t: T) => {
    const next = narrowTo?.(t, q);
    if (next == null) return onPick(t, q);
    setQ?.(next);
    setIdx(0);
  };

  const onKeyDown = (e: { key: string; preventDefault: () => void }): boolean => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx(stepFrom(clamped, 1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx(stepFrom(clamped, -1, results.length));
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && onSide && active) {
      e.preventDefault();
      onSide(active, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "Tab" && ghost?.accept) {
      // tab completes without picking: the point is to keep narrowing
      e.preventDefault();
      setQ?.(q + ghost.accept);
      setIdx(0);
    } else if (e.key === "Tab" && tabPicks && active) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Enter" && clamped < 0 && onIdlePick) {
      e.preventDefault();
      onIdlePick(q);
    } else {
      return false;
    }
    return true;
  };

  return { index: clamped, active, ghost, setIndex: setIdx, pick, onKeyDown };
}
