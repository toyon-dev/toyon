import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { tip } from "./Tooltip.tsx";

/**
 * Every pressable control in the app. The component owns the box: size, padding, border, and the
 * `type="button"` that keeps a control inside a form from submitting it.
 *
 * It exists because the box was the one thing surfaces kept redeciding. Ten semantic classes had
 * each written their own padding on top of .btn's 1px 8px, in ten values, four of them near-misses
 * of the same 4px 8px; three of those landed in a single day with the rule against it already
 * written. Worse, .btn, .qo-item and .ask-opt could stack on one button and all three declare
 * padding, so which one won came down to their line numbers in a 2400-line stylesheet, silently.
 * A size prop has one answer and no cascade to lose.
 *
 * `tone` stays open, because colour is genuinely the surface's business: .ship-btn is amber,
 * .ask-no is red, .stop-btn is italic. What a tone class may not do is touch the box, and
 * button.test.ts is what says so, the way rowDim.test.ts does for the skip tier.
 */
export type ButtonSize = "sm" | "md" | "lg";

const SIZE: Record<ButtonSize, string> = {
  /** the compact default: toolbars, inline actions, anything sitting in a dense row */
  sm: "",
  /** a chip or an option you aim at rather than sweep past */
  md: "btn-md",
  /** the one action a panel is asking for: create, start, ship */
  lg: "btn-lg",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** colour-only semantic class from the surface (.ship-btn, .ask-no). Never the box. */
  tone?: string;
  size?: ButtonSize;
  /** bordered pill; the border takes the text colour on hover */
  outline?: boolean;
  /** an active toggle, not a hover and not a selection */
  on?: boolean;
  children: ReactNode;
};

export function Button({ tone, size = "sm", outline, on, className, type = "button", ...rest }: Props) {
  const cls = ["btn", outline && "btn-outline", SIZE[size], on && "on", tone, className].filter(Boolean).join(" ");
  return <button className={cls} type={type} {...rest} />;
}

type IconProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  icon: IconName;
  /**
   * What the control does, as a sentence a person reads. Required, because an icon on its own says
   * nothing to a screen reader and 20 of the 26 icon-only buttons here had no name until tip()
   * started handing them one; a prop makes the next one a type error instead of a review catch.
   */
  label: string;
  /** shortcut shown set apart in the tooltip, and folded into the accessible name */
  hint?: string;
  tone?: string;
  on?: boolean;
};

/** A 20px square glyph control: pane close, toolbar toggle, a chip's remove. */
export function IconButton({ icon, label, hint, tone, on, className, type = "button", ...rest }: IconProps) {
  const cls = ["btn-icon", on && "on", tone, className].filter(Boolean).join(" ");
  return (
    <button className={cls} type={type} {...tip(label, hint)} {...rest}>
      <Icon name={icon} />
    </button>
  );
}
