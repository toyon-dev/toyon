import { cx } from "./cx.ts";
import "./spinner.css";

/**
 * The one "in progress" mark: a ring with a quarter lit, turning. Two sizes, because it stands in
 * for exactly two things. Inline it takes an Icon's box, and a Button that is `busy` centres it
 * over the label; as a dot it takes the status dot's 8px box, so the rail can swap the dot for it
 * while a sync or a merge runs without the row moving. It never carries a label of its own: the
 * control it sits in says what is happening (a button's tooltip, a badge's).
 */
export function Spinner({ size = "inline", className }: { size?: "inline" | "dot"; className?: string }) {
  return <span className={cx("spinner", size === "dot" && "spinner-dot", className)} aria-hidden="true" />;
}
