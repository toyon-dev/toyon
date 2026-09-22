import { cx } from "./cx.ts";
import "./spinner.css";

/**
 * The one "in progress" mark, in two drawings. The ring (a quarter lit, turning) sits where a
 * control is busy: inline it takes an Icon's box, and a Button that is `busy` centres it over
 * the label; as a dot it takes the status dot's 8px box, so the rail can swap the dot for it
 * while a sync or a merge runs without the row moving. The squares (four cells in the icon box,
 * a lit pair going round) sit in the transcript, where the agent is composing and the
 * mark stands in for words that have not arrived. It never carries a label of its own:
 * the control or row it sits in says what is happening.
 */
export function Spinner({
  size = "inline",
  variant = "ring",
  className,
}: {
  size?: "inline" | "dot";
  variant?: "ring" | "squares";
  className?: string;
}) {
  return (
    <span
      className={cx("spinner", size === "dot" && "spinner-dot", variant === "squares" && "spinner-squares", className)}
      aria-hidden="true"
    />
  );
}
