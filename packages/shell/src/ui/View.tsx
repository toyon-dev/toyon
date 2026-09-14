import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./view.css";
import "./form.css";
import "./status.css";

/** what the column holds still while what is on it grows */
export type ViewAnchor = "top" | "line";

/**
 * A view: what the centre shows when it is not showing their app. Every one of toyon's own sits in
 * this one column, on the centre's own ground and anchored to the top; see view.css for why.
 *
 * What differs between them is the parts, and who is typing picks them. A view a person puts
 * something into uses `form-*`: a title, a body to write in, `FormRow` for a labelled row whose
 * label column is the gutter, `Field`'s `rule` for a value, and `form-sign` naming the file it
 * becomes. A view the machine reports through uses `status-*`: a prose line in the reading face,
 * actions, and `status-tail` for what a process actually printed, which is the only place mono
 * belongs. The parts are classes rather than subcomponents because they have no choices to make,
 * and a class is what the stylesheet tests can see.
 *
 * `anchor="line"` is for the first run only: it drops the first line so the project name typed on
 * the new-project view lands exactly where that project's title reads a moment later. `wide` is
 * for output, which is read rather than written and runs longer than prose.
 */
export function View({ anchor = "top", wide, children }: { anchor?: ViewAnchor; wide?: boolean; children: ReactNode }) {
  return <div className={cx("view", anchor === "line" && "view-anchored", wide && "view-wide")}>{children}</div>;
}
