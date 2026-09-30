import { useRef } from "react";
import { IconButton } from "./Button.tsx";
import { Field } from "./Field.tsx";
import { isFind } from "./find.ts";
import { useOnChange } from "./hooks.ts";
import "./find.css";

/**
 * The find box itself: the field, the count, and the next and previous steps, over the top corner
 * of whatever is being read. What is searched and how a match is marked is its owner's: a document
 * drawn in the DOM is read as text nodes (DocumentFind), and a terminal is asked through xterm,
 * whose scrollback is not in the DOM at all.
 *
 * `seq` ticks when ⌘F is pressed again with the box already open, which puts the caret back in it
 * with its text selected; a `seed` beside it is what the owner had selected at that press.
 */
export function FindBox({
  label,
  query,
  onQuery,
  seed,
  seq,
  status,
  none,
  onStep,
  onClose,
}: {
  /** what is being searched, for a screen reader: "find in this document" */
  label: string;
  query: string;
  onQuery: (query: string) => void;
  seed: string;
  seq: number;
  /** the count as it reads beside the field: "3/12", "no matches", or nothing before a query */
  status: string;
  /** nothing to step between */
  none: boolean;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);

  useOnChange([seq], () => {
    if (seed) onQuery(seed);
    field.current?.focus();
    field.current?.select();
  });

  return (
    <div className="find">
      <Field
        ref={field}
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="find…"
        aria-label={label}
        className="find-field"
        spellCheck={false}
        onKeyDown={(e) => {
          // the surface's Escape would close a pane or leave a page; here the box goes first, and
          // its owner keeps the match as its selection
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
            return;
          }
          // ⌘F again selects what is typed, as the editor's own box does. ⌘G and ⌘⇧G step, as they
          // do in the editor, and are kept from the window, where ⌘G is the search across chats.
          if (isFind(e)) {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.select();
            return;
          }
          if (e.key.toLowerCase() === "g" && (e.metaKey || e.ctrlKey) && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            onStep(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {status}
      </span>
      <IconButton
        icon="caret"
        label="Previous match"
        hint="⇧↩"
        className="find-prev"
        disabled={none}
        onClick={() => onStep(-1)}
      />
      <IconButton icon="caret" label="Next match" hint="↩" disabled={none} onClick={() => onStep(1)} />
      <IconButton icon="close" label="Close" hint="esc" onClick={onClose} />
    </div>
  );
}
