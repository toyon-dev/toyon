import type { ComponentProps, ReactNode } from "react";
import "./check.css";
import { cx } from "./cx.ts";

/**
 * A choice that goes with what the form sends, as against a Button toggle, which acts the moment
 * it is pressed: the composer's "come along" is a checkbox because nothing happens until Enter,
 * and a verb on a button promises otherwise. The box and its sentence are one label, so the
 * sentence is pressable too; `tip` explains the choice, and why it is off when it is.
 */
export function Check({
  children,
  className,
  tip,
  ...rest
}: Omit<ComponentProps<"input">, "type" | "children"> & { children: ReactNode; tip?: string }) {
  return (
    <label className={cx("check", className)} data-tip={tip}>
      <input type="checkbox" className="check-box" {...rest} />
      <span>{children}</span>
    </label>
  );
}
