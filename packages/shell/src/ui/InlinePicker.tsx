import type { ReactNode, RefObject } from "react";
import { cx } from "./cx.ts";
import { Float } from "./Float.tsx";
import { KeyHints } from "./KeyHints.tsx";
import type { ListNav } from "./listNav.ts";
import type { Placement } from "./place.ts";
import "./picker.css";
import { rowState } from "./rowState.ts";

/** on the box being typed in, opening upward over the transcript so the rows never cover what is
 * being written, and inset from both its edges. It drops below only where there is no room above,
 * which is a composer at the very top of a short window. */
const INLINE: Placement = {
  side: "top",
  align: "start",
  offset: 4,
  alignOffset: -10,
  matchWidth: -20,
  flip: "side",
  margin: 8,
};

/**
 * A list on the input the caret is already in, rather than an overlay that takes focus. The host
 * owns the query (it is a slice of what is being typed) and forwards keys through `nav.onKeyDown`;
 * this only draws. Rows reuse the palette's classes so `@` and ⌘P read as the same thing in two
 * places.
 *
 * It is a Float, so the pane the composer sits in cannot clip it: on the first-run screens that
 * pane scrolls, and the menu opening upward was cut off at its edge. It registers nothing with the
 * stack, since it closes when the caret leaves the trigger rather than on a press of its own.
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
    <Float className="inline-picker" anchor="parent" placement={INLINE}>
      <div className="picker-list" ref={listRef}>
        {results.map((t, i) => (
          <button
            key={keyOf(t)}
            className={cx("picker-item", rowClass?.(t))}
            data-state={rowState({ cursor: i === nav.index })}
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
        {results.length === 0 && <div className="empty">{empty}</div>}
      </div>
      <KeyHints
        hints={[
          ["↑↓", "moves"],
          ["tab", "inserts"],
          ["esc", "dismisses"],
        ]}
      />
    </Float>
  );
}
