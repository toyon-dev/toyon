import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useFocusOnMount } from "./hooks.ts";
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
  placeholder,
  initialQuery = "",
  initialIndex,
  empty = "no matches",
  footer,
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
  placeholder: string;
  initialQuery?: string;
  /** where the highlight starts (mount only); default 0 */
  initialIndex?: (results: T[]) => number;
  /** shown when there are no rows; a function sees the query */
  empty?: string | ((q: string) => string);
  /** below the rows (result counts, hints) */
  footer?: (q: string, results: T[]) => ReactNode;
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
  return (
    <Overlay onClose={onBack} boxClass="quick-open">
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
          } else if (e.key === "Enter" && results[clamped]) {
            e.preventDefault();
            onPick(results[clamped]!, q);
          }
        }}
        placeholder={placeholder}
      />
      <div className="qo-list" ref={listRef}>
        {results.map((t, i) => (
          <button
            key={keyOf(t)}
            className={`qo-item ${rowClass?.(t) ?? ""} ${i === clamped ? "active" : ""}`}
            title={rowTitle?.(t)}
            // mousemove, not mouseenter: rows scrolling under a stationary pointer must not steal the highlight
            onMouseMove={() => i !== clamped && setIdx(i)}
            onClick={() => onPick(t, q)}
          >
            {row(t, i === clamped, q)}
          </button>
        ))}
        {results.length === 0 && <div className="dock-empty">{typeof empty === "function" ? empty(q) : empty}</div>}
        {footer?.(q, results)}
      </div>
    </Overlay>
  );
}
