import { cx } from "./cx.ts";
import "./spinner.css";

/**
 * The one "in progress" drawing: four cells in the icon box. Inline, a lit pair goes round: it
 * sits where a control is busy (it takes an Icon's box, and a Button that is `busy` centres it
 * over the label) and in the transcript where the agent is composing and the mark stands in for
 * words that have not arrived. As a dot, in the status dot's 8px box, the cells fill the square
 * and clear instead: the rail swaps the dot for it while a land, a commit or a sync runs, without
 * the row moving, and the walking pair there read as the agent at work (spinner.css says why the
 * gait differs). It never carries a label of its own: the control or row it sits in says what is
 * happening. index.html draws the inline cells once more by hand, for the wait before this bundle
 * has loaded, so a change to that drawing is made twice.
 */
export function Spinner({ size = "inline", className }: { size?: "inline" | "dot"; className?: string }) {
  return (
    <span className={cx("spinner", size === "dot" && "spinner-dot", className)} aria-hidden="true">
      {/* the cells are four elements of their own, so each can fade on the compositor (spinner.css) */}
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
