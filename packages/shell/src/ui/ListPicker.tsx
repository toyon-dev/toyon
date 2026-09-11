import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "./cx.ts";
import { Field } from "./Field.tsx";
import { useFocusOnMount } from "./hooks.ts";
import { KeyHints } from "./KeyHints.tsx";
import { type Narrow, sectionStarts, useListNav } from "./listNav.ts";
import { type MenuEntry, menuStore, useContextMenu } from "./menu.ts";
import { Overlay } from "./Overlay.tsx";
import "./picker.css";
import { rowState } from "./rowState.ts";

export { step } from "./listNav.ts";

/** the verb for each key the picker binds, as the person at the shell would say it */
type KeyVerbs = { nav?: string; side?: string; complete?: string; pick?: string; back?: string };

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
  selectOnMount = false,
  groupOf,
  anchored = false,
  lead,
  trailing,
  empty = "no matches",
  footer,
  keys,
  rowMenu,
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
   * query it becomes and the picker stays open, or a Narrow to also select part of that query (a
   * template's parameter, typed over next); null means hand the row to onPick as usual */
  narrowTo?: (t: T, q: string) => string | Narrow | null;
  placeholder: string;
  initialQuery?: string;
  /** where the highlight starts (mount only); default 0 */
  initialIndex?: (results: T[]) => number;
  /** open with `initialQuery` selected, so the first keystroke replaces it: an address that is
   * shown for reading and typed over to go somewhere else */
  selectOnMount?: boolean;
  /** which section a row belongs to; a rule is drawn where it changes. Rules sit between rows,
   * never among them, so ↑↓ and the highlight only ever land on a row. */
  groupOf?: (t: T) => string;
  /** shown when there are no rows; a function sees the query */
  empty?: string | ((q: string) => string);
  /** below the rows (result counts, hints) */
  footer?: (q: string, results: T[]) => ReactNode;
  /** what this picker's keys do, as the verb for each one. The picker owns the keyboard, so it
   * draws the row and each palette says only what its keys mean. Arrow and modifier characters
   * belong here rather than in `placeholder`, which can only hold a string. `side` is ignored
   * unless `onSide` is wired up, and `complete` unless tab would actually complete something. A
   * function sees the highlighted row, for a picker whose enter means different things per row. */
  keys?: KeyVerbs | ((active: T | null, q: string) => KeyVerbs);
  /** draw as a dropdown under the trigger (the caller renders it inside the trigger's positioned
   * wrapper) instead of a centered overlay over the preview */
  anchored?: boolean;
  /** before the caret: what the query is already scoped to, as a chip */
  lead?: ReactNode;
  /** at the right end of the input row: one escape hatch out of the picker */
  trailing?: ReactNode;
  /** what a right-click on a row offers, for a picker whose rows are things and not only choices
   * (a project has a setup and a forget); a row with nothing gets the app's menu like any chrome */
  rowMenu?: (t: T) => MenuEntry[];
}) {
  const cm = useContextMenu("picker");
  const [q, setQ] = useState(initialQuery);
  const results = useMemo(() => filter(items, q), [items, q, filter]);
  const starts = useMemo(() => sectionStarts(results, groupOf), [results, groupOf]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useFocusOnMount<HTMLInputElement>(selectOnMount);
  /** the range a narrowed row asked for, applied once its query is in the field */
  const pendingSelect = useRef<[number, number] | null>(null);
  useEffect(() => {
    if (!onQuery) return;
    const h = setTimeout(() => onQuery(q), 150);
    return () => clearTimeout(h);
  }, [q, onQuery]);
  // no dependency list: the query a row narrowed to lands in some later render, and this checks
  // after each one, doing nothing until a range is waiting
  useLayoutEffect(() => {
    const range = pendingSelect.current;
    const el = inputRef.current;
    if (!range || !el) return;
    pendingSelect.current = null;
    // a click on the row may have taken focus from the field
    el.focus();
    el.setSelectionRange(range[0], range[1]);
  });
  const nav = useListNav({
    results,
    keyOf,
    q,
    onPick,
    listRef,
    onActive,
    onSide,
    completionOf,
    narrowTo,
    onNarrow: (n) => {
      pendingSelect.current = n.select ?? null;
    },
    setQ,
    initialIndex,
  });
  const { index: clamped, ghost } = nav;
  const verbs = typeof keys === "function" ? keys(nav.active, q) : keys;
  const hints: Array<[string, string]> = [];
  if (verbs?.nav) hints.push(["↑↓", verbs.nav]);
  if (verbs?.side && onSide) hints.push(["←→", verbs.side]);
  // tab is only offered while there is a completion under it: a standing hint for a key that does
  // nothing is worse than no hint
  if (verbs?.complete && ghost) hints.push(["tab", verbs.complete]);
  if (verbs?.pick) hints.push(["enter", verbs.pick]);
  if (verbs?.back) hints.push(["esc", verbs.back]);
  const inputEl = (
    <div className="picker-input">
      {lead}
      <div className="picker-caret">
        <Field
          size="lg"
          font="mono"
          bare={anchored}
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            nav.setIndex(0); // typing resets the highlight; the mount keeps initialIndex
          }}
          onKeyDown={(e) => {
            // the menu key, with the caret in the input: the highlighted row's menu, under that row
            if (rowMenu && nav.active && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
              const row = listRef.current?.querySelector('[data-state~="cursor"]');
              if (row) {
                e.preventDefault();
                e.stopPropagation();
                menuStore.open({
                  items: rowMenu(nav.active),
                  owner: "picker",
                  target: row,
                  anchor: row.getBoundingClientRect(),
                });
                return;
              }
            }
            nav.onKeyDown(e);
          }}
          placeholder={placeholder}
        />
        {ghost && (
          <div className="picker-ghost" aria-hidden="true">
            <span className="picker-typed">{q}</span>
            {ghost}
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
  const listEl = (
    <div className="picker-list" ref={listRef}>
      {results.map((t, i) => (
        <Fragment key={keyOf(t)}>
          {starts[i] && <div className="picker-sep" aria-hidden="true" />}
          <button
            className={cx("picker-item", rowClass?.(t))}
            data-state={rowState({ cursor: i === clamped })}
            title={rowTitle?.(t)}
            // mousemove, not mouseenter: rows scrolling under a stationary pointer must not steal the highlight
            onMouseMove={() => i !== clamped && nav.setIndex(i)}
            onClick={() => nav.pick(t)}
            {...cm.contextMenu(() => rowMenu?.(t) ?? [])}
          >
            {row(t, i === clamped, q)}
          </button>
        </Fragment>
      ))}
      {results.length === 0 && <div className="empty">{typeof empty === "function" ? empty(q) : empty}</div>}
      {footer?.(q, results)}
    </div>
  );
  const keysEl = hints.length > 0 && <KeyHints hints={hints} />;
  return (
    <Overlay onClose={onBack} boxClass="picker" anchored={anchored}>
      {inputEl}
      {listEl}
      {keysEl}
    </Overlay>
  );
}
