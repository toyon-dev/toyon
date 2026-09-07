import type { ReactNode, RefObject } from "react";
import { Kbd } from "./Kbd.tsx";
import type { ListNav } from "./listNav.ts";

/**
 * A list anchored to an input the caret is already in, rather than an overlay that takes focus.
 * The host owns the query (it is a slice of what is being typed) and forwards keys through
 * `nav.onKeyDown`; this only draws. Rows reuse the palette's classes so `@` and ⌘P read as the
 * same thing in two places.
 */
export function InlinePicker<T>({
  results,
  keyOf,
  row,
  rowClass,
  nav,
  listRef,
  empty,
}: {
  results: T[];
  keyOf: (t: T) => string;
  row: (t: T, active: boolean) => ReactNode;
  rowClass?: (t: T) => string;
  nav: ListNav<T>;
  listRef: RefObject<HTMLDivElement>;
  empty: ReactNode;
}) {
  return (
    <div className="inline-picker">
      <div className="qo-list" ref={listRef}>
        {results.map((t, i) => (
          <button
            key={keyOf(t)}
            className={`qo-item ${rowClass?.(t) ?? ""} ${i === nav.index ? "active" : ""}`}
            // mousemove, not mouseenter: rows scrolling under a stationary pointer must not steal
            // the highlight
            onMouseMove={() => i !== nav.index && nav.setIndex(i)}
            // the caret has to survive the click: a blur would close this before onClick runs
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => nav.pick(t)}
          >
            {row(t, i === nav.index)}
          </button>
        ))}
        {results.length === 0 && <div className="dock-empty">{empty}</div>}
      </div>
      <div className="lp-keys">
        <span className="lp-key">
          <Kbd k="↑↓" />
          moves
        </span>
        <span className="lp-key">
          <Kbd k="tab" />
          inserts
        </span>
        <span className="lp-key">
          <Kbd k="esc" />
          dismisses
        </span>
      </div>
    </div>
  );
}
