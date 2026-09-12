import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./form.css";

/** where the column holds still while what is on it grows */
export type FormAnchor = "line" | "top";

/**
 * A form: the dress a view in the centre wears when a person puts something into it. One column on
 * the centre's own ground, with no card, no sheet and no box around what is being written. What
 * makes it a form is the measure, the anchor, the type, and a rule under a field (`Field`'s
 * `rule`); a ground drawn anywhere on it turns it back into the card this replaced.
 *
 * `anchor` names what is held still, which is the only thing its two users differ on. `line` holds
 * the first line a quarter of the way down, so the project name typed on the new-project view is
 * exactly where that project's title reads a moment later; a form centred instead would sit by half
 * of whatever is under its first line, and no two of them have the same thing under it. `top` holds
 * the top, for a form that grows while it is being read: setup gains a row every time another
 * process is added, and a box that bobs is a box you cannot aim at.
 *
 * The parts are classes rather than subcomponents (`form-title`, `form-head`, `form-body`,
 * `form-knobs`, `form-sign`, and `FormRow` for a labelled row). The column is the only part with a
 * choice to make, and a class is what the stylesheet tests can see.
 */
export function Form({
  anchor = "line",
  className,
  children,
}: {
  anchor?: FormAnchor;
  /** how the form sits in the centre. Never its ground, its measure or its type. */
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("form", anchor === "top" ? "form-top" : "form-line", className)}>{children}</div>;
}
