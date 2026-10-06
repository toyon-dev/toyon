import type { ReactNode, RefObject } from "react";
import { useTouch } from "../state/selectors.ts";
import "./choices.css";
import { cx } from "./cx.ts";
import { TextArea } from "./Field.tsx";
import { Kbd } from "./Kbd.tsx";
import { rowState } from "./rowState.ts";

/** what a row holds once something is typed against it: the "other" row's answer, or a note on
 * the pick. One line that grows with what is typed, under the row's label and description. The
 * caret is the owner's to place: the ref is theirs, since whether a field opening takes the
 * keyboard depends on what opened it. */
export type ChoiceField = {
  ref?: RefObject<HTMLTextAreaElement>;
  value: string;
  placeholder: string;
  /** what the on-screen keyboard's return key is named for */
  enterKeyHint: "send" | "next";
  onChange: (value: string) => void;
};

export type Choice = {
  label: ReactNode;
  /** under the label at the row's full width, on every row: a line that came and went with the
   * cursor moved every row below it as the pointer crossed the list */
  description?: ReactNode;
  /** the one key that acts on this row rather than the list, said on the row it would act on at
   * the end of the label's line. Every row keeps the room for it and only the cursor's shows it,
   * so a label wraps the same wherever the cursor is; `on` false keeps the room and hides it. */
  hint?: { k: string; label: string; on?: boolean };
  /** saying no to the agent stops something mid-flight, which is what the danger tone is for */
  tone?: "deny";
  /** the person's pick, marked the one way this app marks a selection */
  checked?: boolean;
  disabled?: boolean;
  /** the row holds a field: it is then no longer a button, and a press beside the field puts the
   * caret in rather than dropping it */
  field?: ChoiceField;
};

/**
 * The numbered rows a card offers: one picked by its digit, by the arrows and enter, or by a
 * press. A row is a block, not a flex row: the digit in a gutter so the labels line up under each
 * other however many rows there are, the label on the first line, the description wrapping under
 * it. Prose, not a path: the palette's rows are mono because they hold literals you also type,
 * and a choice's label and description are neither. The description is often the only thing
 * telling two rows apart, so it wraps rather than ellipsising the way the slash menu's do.
 *
 * The keyboard is the owner's (`choiceKeys.ts` reads it): this draws the cursor where it is told
 * and reports where the pointer moved it. A touch window has no cursor: drawn there, it sat on the
 * first row before anything was tapped and read as a choice already made.
 */
export function Choices({
  rows,
  cursor,
  onCursor,
  onPick,
  hover = false,
}: {
  rows: Choice[];
  cursor?: number;
  onCursor?: (i: number) => void;
  onPick: (i: number) => void;
  /** no cursor walks these rows, so the pointer's seat is theirs to draw */
  hover?: boolean;
}) {
  const touch = useTouch();
  /** a press on a row holding a field, beside the field: the caret goes in rather than being dropped */
  const toField = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    e.currentTarget.querySelector("textarea")?.focus();
  };
  return (
    // the digits are a hardware keyboard's idiom: on a touch window the rows are tapped, and the
    // gutter goes with the digit
    <div className={cx("choices", hover && "choices-hover", touch && "choices-touch")}>
      {rows.map((row, i) => {
        const on = !touch && cursor === i;
        const state = rowState({ cursor: on, checked: row.checked });
        const deny = row.tone === "deny" && "choice-deny";
        // mousemove, not mouseenter, for the same reason the picker gives: a row arriving under a
        // stationary pointer must not steal the highlight the keyboard is on
        const toRow = () => onCursor && cursor !== i && onCursor(i);
        const body = (
          <>
            {!touch && <Kbd k={String(i + 1)} className="choice-num row-dim" />}
            <span className="choice-label">{row.label}</span>
            {!touch && row.hint && (
              <span className={cx("choice-hint row-dim", on && row.hint.on !== false && "on")}>
                <Kbd k={row.hint.k} /> {row.hint.label}
              </span>
            )}
            {row.description && <span className="choice-desc">{row.description}</span>}
          </>
        );
        if (row.field)
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are a question's fixed options, never reordered
              key={i}
              className={cx("picker-item choice row-edge", deny)}
              data-state={state}
              onMouseMove={toRow}
              onMouseDown={toField}
            >
              {body}
              <TextArea
                ref={row.field.ref}
                bare
                font="ui"
                rows={1}
                className="choice-field"
                enterKeyHint={row.field.enterKeyHint}
                placeholder={row.field.placeholder}
                value={row.field.value}
                onChange={(e) => row.field?.onChange(e.target.value)}
              />
            </div>
          );
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are a question's fixed options, never reordered
            key={i}
            type="button"
            className={cx("picker-item choice row-edge", deny)}
            data-state={state}
            disabled={row.disabled}
            onMouseMove={toRow}
            onClick={() => onPick(i)}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
