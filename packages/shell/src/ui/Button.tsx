import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { tip } from "./Tooltip.tsx";
import "./button.css";

/**
 * Every pressable control in the app, across five closed axes: variant, size, tone, `on`, `mono`.
 *
 * Each of the five is small because each was counted rather than chosen from a list other design
 * systems publish. At rest exactly two things ever varied the treatment, so there are three
 * variants and no `solid`, `link` or `transparent`. Twenty semantic classes held seven colour
 * values between them, and only four meanings once `on` was separated out of them, so there are
 * four tones. Five controls set the mono face, so `mono` is a prop; one set a smaller ui face, so
 * that stayed with its surface.
 *
 * What the axes replaced, in order of how quietly it went wrong:
 *
 * The box. Ten semantic classes had each written their own padding on .btn's 1px 8px, four of them
 * near-misses of the same 4px 8px. An AskCard option was `btn btn-outline qo-item ask-opt`, three
 * of which declare padding at equal specificity, so the winner was their line numbers in a
 * 2400-line stylesheet; qo-item won and dragged a list row's width and min-height onto a chip.
 *
 * The `on` state. base.css had .btn-icon.on and no .btn.on, so six surfaces each wrote
 * `color: var(--accent)` for their own. They agreed, which is luck rather than a system, and the
 * two that did not agree (the project pill's seat, the composer picker's accent) were overrides
 * winning on source order rather than choices anyone could read.
 *
 * Dead colour. .rb-btn set the text1 that .btn-icon already sets, and .toggle restated
 * .btn-icon.on. A class that does nothing is what an open escape hatch produces, so `className`
 * no longer carries colour: it is left only for how a button sits in its parent (a max-width, a
 * flex-shrink), which is genuinely the surface's business. styles/button.test.ts holds that line.
 */
export type ButtonSize = "sm" | "md" | "lg";
export type ButtonVariant = "ghost" | "outline" | "field";
export type ButtonTone = "primary" | "quiet" | "danger" | "chrome";

const SIZE: Record<ButtonSize, string> = {
  /** the compact default: toolbars, inline actions, anything in a dense row */
  sm: "",
  /** a chip or an option you aim at rather than sweep past */
  md: "btn-md",
  /** the one action a panel is asking for: create, start, ship */
  lg: "btn-lg",
};

const VARIANT: Record<ButtonVariant, string> = {
  /** text only, no border: the quiet default */
  ghost: "",
  /** bordered pill; the border takes the text colour on hover */
  outline: "btn-outline",
  /** drawn as a form field, because it holds a current value you click to change */
  field: "btn-outline btn-field",
};

const TONE: Record<ButtonTone, string> = {
  /** the action this surface is actually offering */
  primary: "tone-primary",
  /** a way out, an aside, a link: present but not asking for you */
  quiet: "tone-quiet",
  /** deletes something, or stops something mid-flight */
  danger: "tone-danger",
  /** a toolbar switch: `on` is a deeper seat, never accent, and the glyph keeps its colour */
  chrome: "tone-chrome",
};

type Shared = {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  /** an active toggle. Not a hover, and not a selection. */
  on?: boolean;
  /** the mono face, for a control holding a literal the person types elsewhere: a branch, a path */
  mono?: boolean;
  /** how the button sits in its parent (max-width, flex-shrink). Never its colour or its box. */
  className?: string;
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> &
  Shared & {
    size?: ButtonSize;
    children: ReactNode;
  };

export function Button({ variant = "ghost", size = "sm", tone, on, mono, className, type = "button", ...rest }: Props) {
  const cls = ["btn", VARIANT[variant], SIZE[size], tone && TONE[tone], on && "on", mono && "btn-mono", className]
    .filter(Boolean)
    .join(" ");
  return <button className={cls} type={type} {...rest} />;
}

type IconProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> &
  Shared & {
    icon: IconName;
    /**
     * What the control does, as a sentence a person reads. Required, because an icon on its own
     * says nothing to a screen reader and 20 of the 26 icon-only buttons here had no name until
     * tip() started handing them one; a prop makes the next one a type error, not a review catch.
     */
    label: string;
    /** shortcut shown set apart in the tooltip, and folded into the accessible name */
    hint?: string;
  };

/** A 20px square glyph control: a pane's close, a toolbar switch, a chip's remove. */
export function IconButton({ icon, label, hint, tone, on, className, type = "button", ...rest }: IconProps) {
  const cls = ["btn-icon", tone && TONE[tone], on && "on", className].filter(Boolean).join(" ");
  return (
    <button className={cls} type={type} {...tip(label, hint)} {...rest}>
      <Icon name={icon} />
    </button>
  );
}
