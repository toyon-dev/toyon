import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useFocusOnMount } from "./hooks.ts";
import { Kbd } from "./Kbd.tsx";
import { Overlay } from "./Overlay.tsx";

/** ↑↓ with wrap-around */
export function step(i: number, delta: number, n: number): number {
  return n === 0 ? 0 : (i + delta + n) % n;
}

/**
 * The one list-picker: overlay + filter input + rows, ↑↓ wrap, enter picks, ←→ optional, hover
 * highlights, active row reported so a parent can live-preview. Every palette-shaped overlay
 * builds on this rather than carrying its own copy of the keyboard machinery. Async sources
 * (search) pass `onQuery` and feed results back through `items`.
 */
export function ListPicker<T>({
  items,
  filter,
  keyOf,
  row,
  rowClass,
  rowTitle,
  onPick,
  onBack,
  onActive,
  onSide,
  onQuery,
  completionOf,
  narrowTo,
  placeholder,
  initialQuery = "",
  initialIndex,
  empty = "no matches",
  footer,
  keys,
}: {
  items: T[];
  /** narrow the list for a query (empty query → everything) */
  filter: (items: T[], q: string) => T[];
  keyOf: (t: T) => string;
  row: (t: T, active: boolean, q: string) => ReactNode;
  rowClass?: (t: T) => string;
  rowTitle?: (t: T) => string;
  onPick: (t: T, q: string) => void;
  /** esc / outside click */
  onBack: () => void;
  onActive?: (t: T | null) => void;
  /** ←→ on the highlighted row */
  onSide?: (t: T, dir: -1 | 1) => void;
  /** debounced (150ms): the query changed and the source should fetch (async pickers) */
  onQuery?: (q: string) => void;
  /** what the highlighted row would complete the query to; the remainder is drawn as ghost text
   * after the caret and tab accepts it. Return null when the row cannot extend what was typed. */
  completionOf?: (t: T, q: string) => string | null;
  /** a row that narrows the search instead of ending it (a folder to descend into): return the
   * query it becomes and the picker stays open; null means hand the row to onPick as usual */
  narrowTo?: (t: T, q: string) => string | null;
  placeholder: string;
  initialQuery?: string;
  /** where the highlight starts (mount only); default 0 */
  initialIndex?: (results: T[]) => number;
  /** shown when there are no rows; a function sees the query */
  empty?: string | ((q: string) => string);
  /** below the rows (result counts, hints) */
  footer?: (q: string, results: T[]) => ReactNode;
  /** what this picker's keys do, as the verb for each one. The picker owns the keyboard, so it
   * draws the row and each palette says only what its keys mean. Arrow and modifier characters
   * belong here rather than in `placeholder`, which can only hold a string. `side` and
   * `complete` are ignored unless `onSide` / `completionOf` are wired up. */
  keys?: { nav?: string; side?: string; complete?: string; pick?: string; back?: string };
}) {
  const [q, setQ] = useState(initialQuery);
  const results = useMemo(() => filter(items, q), [items, q, filter]);
  const [idx, setIdx] = useState(() => Math.max(0, initialIndex?.(results) ?? 0));
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useFocusOnMount<HTMLInputElement>();
  useEffect(() => {
    if (!onQuery) return;
    const h = setTimeout(() => onQuery(q), 150);
    return () => clearTimeout(h);
  }, [q, onQuery]);
  // keyed on the row's key, not the results array: parents rebuild items every render, and a
  // re-report on identity change would reset any state they keep for the active row (←→ peek)
  const activeKey = results[idx] ? keyOf(results[idx]!) : null;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".qo-item.active")?.scrollIntoView({ block: "nearest" });
    onActive?.(results[idx] ?? null);
  }, [activeKey]);
  // results can shrink under the highlight (async sources): step from the visible row
  const clamped = Math.min(idx, Math.max(0, results.length - 1));
  const pick = (t: T) => {
    const next = narrowTo?.(t, q);
    if (next == null) return onPick(t, q);
    setQ(next);
    setIdx(0);
  };
  // the ghost is only ever the tail of what the row would complete to, so what is drawn under the
  // caret stays exactly what was typed (a case-insensitive match must not repaint the typed part)
  const completion = results[clamped] ? completionOf?.(results[clamped]!, q) : null;
  const ghost =
    completion && completion.length > q.length && completion.toLowerCase().startsWith(q.toLowerCase())
      ? completion.slice(q.length)
      : null;
  const hints: Array<[string, string]> = [];
  if (keys?.nav) hints.push(["↑↓", keys.nav]);
  if (keys?.side && onSide) hints.push(["←→", keys.side]);
  if (keys?.complete && completionOf) hints.push(["tab", keys.complete]);
  if (keys?.pick) hints.push(["enter", keys.pick]);
  if (keys?.back) hints.push(["esc", keys.back]);
  return (
    <Overlay onClose={onBack} boxClass="quick-open">
      <div className="lp-input">
        <input
          className="field field-lg"
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0); // typing resets the highlight; the mount keeps initialIndex
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx(step(clamped, 1, results.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx(step(clamped, -1, results.length));
            } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && onSide && results[clamped]) {
              e.preventDefault();
              onSide(results[clamped]!, e.key === "ArrowLeft" ? -1 : 1);
            } else if (e.key === "Tab" && ghost) {
              // tab completes without picking: the point is to keep narrowing
              e.preventDefault();
              setQ(q + ghost);
              setIdx(0);
            } else if (e.key === "Enter" && results[clamped]) {
              e.preventDefault();
              pick(results[clamped]!);
            }
          }}
          placeholder={placeholder}
        />
        {ghost && (
          <div className="lp-ghost" aria-hidden="true">
            <span className="lp-typed">{q}</span>
            {ghost}
          </div>
        )}
      </div>
      <div className="qo-list" ref={listRef}>
        {results.map((t, i) => (
          <button
            key={keyOf(t)}
            className={`qo-item ${rowClass?.(t) ?? ""} ${i === clamped ? "active" : ""}`}
            title={rowTitle?.(t)}
            // mousemove, not mouseenter: rows scrolling under a stationary pointer must not steal the highlight
            onMouseMove={() => i !== clamped && setIdx(i)}
            onClick={() => pick(t)}
          >
            {row(t, i === clamped, q)}
          </button>
        ))}
        {results.length === 0 && <div className="dock-empty">{typeof empty === "function" ? empty(q) : empty}</div>}
        {footer?.(q, results)}
      </div>
      {hints.length > 0 && (
        <div className="lp-keys">
          {hints.map(([k, label]) => (
            <span key={k} className="lp-key">
              <Kbd k={k} />
              {label}
            </span>
          ))}
        </div>
      )}
    </Overlay>
  );
}
