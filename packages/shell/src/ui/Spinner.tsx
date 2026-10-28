import { cx } from "./cx.ts";
import "./spinner.css";

/**
 * The one "in progress" mark: four cells in the icon box, a lit pair going round. It sits where
 * a control is busy (it takes an Icon's box, and a Button that is `busy` centres it over the
 * label) and in the transcript where the agent is composing and the mark stands in for words
 * that have not arrived. Not in the rail: a git op there is the background dot, since a mark of
 * its own in the dot's seat read as the agent at work. It never carries a label of its own: the
 * control or row it sits in says what is happening. index.html draws the cells once more by
 * hand, for the wait before this bundle has loaded, so a change to the drawing is made twice.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cx("spinner", className)} aria-hidden="true">
      {/* the cells are four elements of their own, so each can fade on the compositor (spinner.css) */}
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
