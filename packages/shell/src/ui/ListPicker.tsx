import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "./cx.ts";
import { Field } from "./Field.tsx";
import { useFocusOnMount } from "./hooks.ts";
import { KeyHints } from "./KeyHints.tsx";
import { type Completion, type Ghost, useListNav } from "./listNav.ts";
import { type MenuEntry, menuStore, useContextMenu } from "./menu.ts";
import { Overlay } from "./Overlay.tsx";
import "./picker.css";
import { rowState } from "./rowState.ts";

export { step } from "./listNav.ts";

/** the verb for each key the picker binds, as the person at the shell would say it */
type KeyVerbs = { nav?: string; side?: string; complete?: string; pick?: string; back?: string };

/** the ghost's text with its placeholder ranges drawn as placeholders */
function ghostText({ text, params }: Ghost): ReactNode {
  if (params.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of params) {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <span key={a} className="picker-ghost-param">
        {text.slice(a, b)}
      </span>,
    );
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
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
  selectOnMount = false,
  idleWhen,
  onIdlePick,
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
  rowTitle?: (t: T) => string | undefined;
  onPick: (t: T, q: string) => void;
  /** esc / outside click */
  onBack: () => void;
  onActive?: (t: T | null) => void;
  /** ←→ on the highlighted row */
  onSide?: (t: T, dir: -1 | 1) => void;
  /** debounced (150ms): the query changed and the source should fetch (async pickers) */
  onQuery?: (q: string) => void;
  /** what the highlighted row would complete the query to; the remainder is drawn as ghost text
   * after the caret and tab accepts it. A Completion shows more than tab takes (a template's
   * parameter, drawn as a placeholder). Return null when the row cannot extend what was typed. */
  completionOf?: (t: T, q: string) => string | Completion | null;
  /** a row that narrows the search instead of ending it (a folder to descend into): return the
   * query it becomes and the picker stays open; null means hand the row to onPick as usual */
  narrowTo?: (t: T, q: string) => string | null;
  placeholder: string;
  initialQuery?: string;
  /** where the highlight starts (mount only); default 0 */
  initialIndex?: (results: T[]) => number;
  /** open with `initialQuery` selected, so the first keystroke replaces it: an address that is
   * shown for reading and typed over to go somewhere else */
  selectOnMount?: boolean;
  /** a query that means nothing has been chosen yet (an address shown as it is): while the query is
   * one, no row is highlighted, and typing anything else highlights the first row */
  idleWhen?: (q: string) => boolean;
  /** enter while no row is highlighted */
  onIdlePick?: (q: string) => void;
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
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useFocusOnMount<HTMLInputElement>(selectOnMount);
  useEffect(() => {
    if (!onQuery) return;
    const h = setTimeout(() => onQuery(q), 150);
    return () => clearTimeout(h);
  }, [q, onQuery]);
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
    setQ,
    initialIndex,
    idle: idleWhen?.(initialQuery) ?? false,
    onIdlePick,
  });
  const { index: clamped, ghost } = nav;
  const verbs = typeof keys === "function" ? keys(nav.active, q) : keys;
  const hints: Array<[string, string]> = [];
  if (verbs?.nav) hints.push(["↑↓", verbs.nav]);
  if (verbs?.side && onSide) hints.push(["←→", verbs.side]);
  // tab is only offered while there is a completion under it: a standing hint for a key that does
  // nothing is worse than no hint
  if (verbs?.complete && ghost?.accept) hints.push(["tab", verbs.complete]);
  if (verbs?.pick) hints.push(["enter", verbs.pick]);
  if (verbs?.back) hints.push(["esc", verbs.back]);
  const inputEl = (
    <div
      className="picker-input"
      // the strip is drawn as the field, so a press on its padding belongs in the field; otherwise it
      // lands on a div and focus leaves for the body, where the next keystroke goes nowhere
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("input, button")) return;
        e.preventDefault();
        inputRef.current?.focus();
      }}
    >
      {lead}
      <div className="picker-caret">
        <Field
          font="mono"
          bare
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // typing resets the highlight to the first row, or to none when the query is back to one
            // that chooses nothing; the mount keeps initialIndex
            nav.setIndex(idleWhen?.(e.target.value) ? -1 : 0);
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
            {ghostText(ghost)}
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
  const listEl = (
    <div className="picker-list" ref={listRef}>
      {results.map((t, i) => (
        <button
          key={keyOf(t)}
          className={cx("picker-item", rowClass?.(t))}
          data-state={rowState({ cursor: i === clamped })}
          title={rowTitle?.(t)}
          // mousemove, not mouseenter: rows scrolling under a stationary pointer must not steal the highlight
          onMouseMove={() => i !== clamped && nav.setIndex(i)}
          onClick={() => {
            nav.pick(t);
            // a row that only narrowed the query leaves the picker open, and the click took the
            // caret with it; the field is where the next keystroke belongs
            inputRef.current?.focus();
          }}
          {...cm.contextMenu(() => rowMenu?.(t) ?? [])}
        >
          {row(t, i === clamped, q)}
        </button>
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
