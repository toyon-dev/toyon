import { Fragment, type HTMLAttributes, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTouch } from "../state/selectors.ts";
import { cx } from "./cx.ts";
import { Field } from "./Field.tsx";
import { useFocusOnMount, useOnChange } from "./hooks.ts";
import { KeyHints } from "./KeyHints.tsx";
import { type Completion, type Ghost, useListNav } from "./listNav.ts";
import { type MenuEntry, menuStore, useContextMenu } from "./menu.ts";
import { type Anchored, Overlay } from "./Overlay.tsx";
import "./picker.css";
import { rowState } from "./rowState.ts";

export { step } from "./listNav.ts";

/** the verb for each key the picker binds, as the person at the shell would say it */
type KeyVerbs = { nav?: string; side?: string; complete?: string; tab?: string; pick?: string; back?: string };

/** A picker whose strip is a field of the page, with the list floating under it: an address bar,
 * which is a field first and a list second. The strip stays mounted where the picker is rendered
 * and is the one input there is; only the list opens and closes. */
export type FieldMode = {
  /** the list is up */
  open: boolean;
  /** the field asks for its list: the caret arrives, a key is typed, ↓ is pressed */
  onOpen: () => void;
  /** the list's id, which the field names (`aria-controls`) so a press in it keeps the list up */
  id: string;
  /** how the strip sits in its parent, and what it says of itself (a tooltip) */
  className?: string;
  attrs?: HTMLAttributes<HTMLDivElement>;
};

/** collapse a field's selection to its end, so nothing is left selected in it */
function letGo(el: HTMLInputElement) {
  const end = el.value.length;
  el.setSelectionRange(end, end);
}

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
 * (search) pass `onQuery` and feed results back through `items`. A `field` picker is the other
 * shape: the strip is a field of the page and only the list floats, under it.
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
  onTab,
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
  onEscape,
  lead,
  trailing,
  empty = "no matches",
  footer,
  keys,
  rowMenu,
  groupOf,
  groupHead,
  headAlone = false,
  field,
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
  /** tab, in a picker with nothing to complete: the one switch it has (what a search looks through) */
  onTab?: () => void;
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
   * unless `onSide` is wired up, `complete` unless tab would actually complete something, and `tab`
   * unless `onTab` is wired up. A
   * function sees the highlighted row, for a picker whose enter means different things per row. */
  keys?: KeyVerbs | ((active: T | null, q: string) => KeyVerbs);
  /** draw as a dropdown on the control that opened it (the caller renders it inside that control's
   * wrapper, which is what it is placed against) instead of a centred overlay over the preview */
  anchored?: boolean | Anchored;
  /** Escape while this picker is the topmost float, for one that the store does not own: a chip's
   * panel is local state, and closing through the store would shut whatever the chip sits in */
  onEscape?: () => void;
  /** before the caret: what the query is already scoped to, as a chip */
  lead?: ReactNode;
  /** at the right end of the input row: one escape hatch out of the picker */
  trailing?: ReactNode;
  /** what a right-click on a row offers, for a picker whose rows are things and not only choices
   * (a project has a setup and a forget); a row with nothing gets the app's menu like any chrome */
  rowMenu?: (t: T) => MenuEntry[];
  /** the group a row belongs to, for a list of more than one kind of thing (branches and PRs).
   * A head is drawn where the group changes, so `filter` must already have put each group's rows
   * together; the head is a label and never a row the keyboard stops on. With one group in the
   * results no head is drawn, since the rows say what they are themselves. */
  groupOf?: (t: T) => string;
  /** the head for a group, given its key and how many rows it holds */
  groupHead?: (group: string, n: number) => ReactNode;
  /** draw the head over a lone group too: for rows that say nothing of where they belong (a chat's
   * hits carry no chat name), the head is the only thing that does */
  headAlone?: boolean;
  /** the strip as a field of the page and the list as a float under it, rather than one box that
   * mounts and goes. Closed, the field shows `initialQuery` and follows it; the draft starts from
   * it when the list opens and goes back to it when the list closes, as an address bar's text
   * returns to the page's address. The field is a plain input: a click in it at rest selects the
   * whole address, the way a browser's does, so typing replaces it, and a drag selects what was
   * dragged. `selectOnMount` is then what a chord does, opening the list with the caret elsewhere. */
  field?: FieldMode;
}) {
  const cm = useContextMenu("picker");
  const [q, setQ] = useState(initialQuery);
  const results = useMemo(() => filter(items, q), [items, q, filter]);
  const listRef = useRef<HTMLDivElement>(null);
  // the field takes the caret on open, except on touch, where that is the keyboard over the list.
  // A field of the page is not taken on mount: it is there before anything is asked of it.
  const touch = useTouch();
  const inputRef = useFocusOnMount<HTMLInputElement>(selectOnMount, !touch && !field);
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
  const open = field ? field.open : true;
  // a field of the page: closed, it shows the address and follows it, and the draft and the
  // highlight go back to the start whenever the list closes (a pick, Escape, a press elsewhere)
  useOnChange([open, initialQuery], () => {
    if (!field || open) return;
    setQ(initialQuery);
    nav.setIndex(idleWhen?.(initialQuery) ? -1 : 0);
  });
  // the list opened by something other than the field (a chord): the caret goes to the field, and
  // the address under it is selected so typing replaces it. Opened by the field itself, the caret
  // is already there with whatever the press selected, which is left alone. On the next frame too,
  // as on mount: a chord may arrive while the preview iframe holds focus.
  useOnChange([open], () => {
    if (!field || !open || touch) return;
    const take = () => {
      const el = inputRef.current;
      if (!el || document.activeElement === el) return;
      el.focus();
      if (selectOnMount) el.select();
    };
    take();
    const f = requestAnimationFrame(take);
    return () => cancelAnimationFrame(f);
  });
  // whether the press that is running landed in a field at rest: a click there selects the whole
  // address, as a browser's does; one in a field already holding the caret only moves it
  const pressedAtRest = useRef(false);
  const verbs = typeof keys === "function" ? keys(nav.active, q) : keys;
  const hints: Array<[string, string]> = [];
  if (verbs?.nav) hints.push(["↑↓", verbs.nav]);
  if (verbs?.side && onSide) hints.push(["←→", verbs.side]);
  // tab is only offered while there is a completion under it: a standing hint for a key that does
  // nothing is worse than no hint
  if (verbs?.complete && ghost?.accept) hints.push(["tab", verbs.complete]);
  if (verbs?.tab && onTab) hints.push(["tab", verbs.tab]);
  if (verbs?.pick) hints.push(["enter", verbs.pick]);
  if (verbs?.back) hints.push(["esc", verbs.back]);
  // the strip, holding the float under a field of the page: placed against the strip and following
  // it, and reached by the strip's own rules
  const strip = (float?: ReactNode) => (
    <div
      {...field?.attrs}
      className={cx("picker-input", field && "picker-field", field?.className)}
      data-open={field?.open || undefined}
      // the strip is drawn as the field, so a press on its padding belongs in the field; otherwise it
      // lands on a div and focus leaves for the body, where the next keystroke goes nowhere. A
      // button in the strip changes what the field searches, so its press keeps the caret too: the
      // click still fires, and the arrows and the next letter go on working. A press in the list
      // floating under a field is the list's own.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("input, .float")) return;
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
          // a query is an identifier (a path, a file, a command), never a word to check
          spellCheck={false}
          aria-controls={field?.id}
          aria-expanded={field ? field.open : undefined}
          onFocus={() => {
            if (field && !field.open) field.onOpen();
          }}
          onBlur={(e) => {
            // the caret left for a control of the page (tab, a click on a button beside the field):
            // the list goes with it. Left for nothing (the window, the preview) or for a float, the
            // stack decides, as it does for every float.
            const to = e.relatedTarget;
            if (field?.open && to instanceof Element && !to.closest(".float")) onBack();
          }}
          onMouseDown={(e) => {
            const atRest = document.activeElement !== e.currentTarget;
            pressedAtRest.current = atRest;
            // the page's selection stays in the field after Tab takes the caret away (the field's
            // own selection API does not reach it then), and a press landing inside it would drag
            // that text instead of placing the caret: the page lets go of it before the press lands
            if (field && atRest) {
              const s = document.getSelection();
              if (s && (!s.isCollapsed || s.toString() !== "")) s.removeAllRanges();
            }
          }}
          // after the click, not in it: a press on a field at rest places its caret as the press
          // ends, and in the browser that is after the click has been handed out. A caret still
          // collapsed then says the press was a click and not a drag.
          onClick={(e) => {
            if (!field || !pressedAtRest.current) return;
            pressedAtRest.current = false;
            const el = e.currentTarget;
            setTimeout(() => {
              if (document.activeElement === el && el.selectionStart === el.selectionEnd) el.select();
            }, 0);
          }}
          onChange={(e) => {
            setQ(e.target.value);
            // typing resets the highlight to the first row, or to none when the query is back to one
            // that chooses nothing; the mount keeps initialIndex
            nav.setIndex(idleWhen?.(e.target.value) ? -1 : 0);
            if (field && !field.open) field.onOpen();
          }}
          onKeyDown={(e) => {
            if (field && !field.open) {
              // a field with its list away: ↓↑ ask for it back, Escape gives up the caret. The
              // selection is let go first: a blur from script leaves the page's selection in the
              // field, and the blur handler's own attempt comes too late to move it.
              if (e.key === "ArrowDown" || e.key === "ArrowUp") field.onOpen();
              else if (e.key === "Escape") {
                letGo(e.currentTarget);
                e.currentTarget.blur();
                return;
              }
            }
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
            if (nav.onKeyDown(e) || !onTab || e.key !== "Tab" || e.shiftKey) return;
            e.preventDefault();
            onTab();
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
      {float}
    </div>
  );
  const counts = new Map<string, number>();
  if (groupOf) for (const t of results) counts.set(groupOf(t), (counts.get(groupOf(t)) ?? 0) + 1);
  const listEl = (
    <div
      className="picker-list"
      ref={listRef}
      // under a field of the page, a press on a row keeps the caret in the field: the row's click
      // still fires, and the field never blurs for it. A press on the list's own scrollbar is on
      // the list element itself and is left to the browser.
      onMouseDown={(e) => {
        if (field && e.target !== e.currentTarget) e.preventDefault();
      }}
    >
      {results.map((t, i) => {
        const group = groupOf?.(t);
        const head =
          group !== undefined &&
          (headAlone || counts.size > 1) &&
          (i === 0 || groupOf?.(results[i - 1] as T) !== group) ? (
            <div className="picker-group">{groupHead?.(group, counts.get(group) ?? 0) ?? group}</div>
          ) : null;
        return (
          <Fragment key={keyOf(t)}>
            {head}
            <button
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
          </Fragment>
        );
      })}
      {results.length === 0 && <div className="empty">{typeof empty === "function" ? empty(q) : empty}</div>}
      {footer?.(q, results)}
    </div>
  );
  const keysEl = hints.length > 0 && <KeyHints hints={hints} />;
  if (field) {
    return strip(
      field.open && (
        <Overlay onClose={onBack} onEscape={onEscape} boxClass="picker" anchored={anchored} id={field.id}>
          {listEl}
          {keysEl}
        </Overlay>
      ),
    );
  }
  return (
    <Overlay
      onClose={onBack}
      onEscape={onEscape}
      boxClass="picker"
      anchored={anchored}
      // the strip's lead is what lands on the control: the chip's value stays where it was. With no
      // lead, a trailing control lands there instead, so a close opens under the finger that opened it
      coverBy={lead ? ".picker-input > *:first-child" : trailing ? ".picker-input > *:last-child" : undefined}
    >
      {strip()}
      {listEl}
      {keysEl}
    </Overlay>
  );
}
