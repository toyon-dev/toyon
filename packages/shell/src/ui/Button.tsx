import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Spinner } from "./Spinner.tsx";
import { type TipAlso, tip } from "./Tooltip.tsx";
import "./button.css";

/**
 * Every pressable control in the app, across five closed axes: variant, size, tone, `on`, `mono`,
 * and one more state, `busy`, for the moment between a press and its answer.
 *
 * Each axis is closed: a variant, size or tone that is not here is added here, not in a surface's
 * stylesheet. `className` never carries colour or the box; it is left for how a button sits in its
 * parent (a max-width, a flex-shrink), which is genuinely the surface's business.
 * styles/button.test.ts holds that line.
 */
export type ButtonSize = "sm" | "md" | "lg";
export type ButtonVariant = "ghost" | "outline" | "field" | "inline";
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
  /** a word in a sentence that can be pressed: the sentence's own face and colour, and no box */
  inline: "btn-inline",
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
    /**
     * The press went out and the answer is not back. Disabled, so a second press cannot send it
     * again, and a spinner sits over the label in a box that keeps the label's size, so the
     * control you pressed is the one that answers you and nothing beside it moves. A state and
     * not a tone: it says nothing about what the button means, only that it is mid-flight.
     */
    busy?: boolean;
    children: ReactNode;
  };

export function Button({
  variant = "ghost",
  size = "sm",
  tone,
  on,
  mono,
  busy,
  className,
  type = "button",
  disabled,
  children,
  ...rest
}: Props) {
  const cls = cx(
    "btn",
    VARIANT[variant],
    SIZE[size],
    tone && TONE[tone],
    on && "on",
    mono && "btn-mono",
    busy && "btn-busy",
    className,
  );
  return (
    <button className={cls} type={type} disabled={busy || disabled} aria-busy={busy || undefined} {...rest}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

type IconProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> &
  Shared & {
    /** an Icon by name, or a drawn glyph that takes a value (a Ring's fraction) and so cannot be one */
    icon: IconName | ReactElement;
    /**
     * What the control does, as a sentence a person reads. Required, because an icon on its own
     * says nothing to a screen reader and 20 of the 26 icon-only buttons here had no name until
     * tip() started handing them one; a prop makes the next one a type error, not a review catch.
     */
    label: string;
    /** shortcut shown set apart in the tooltip, and folded into the accessible name */
    hint?: string;
    /** a second line under the tooltip's text: the figures behind a gauge */
    detail?: string;
    /** the sibling verb and its key, a row under the tooltip's text */
    also?: TipAlso;
    /** a mark over the glyph's corner, positioned by the caller's class: the composer's terminal
     * button wears a dot while a proc is down. A slot rather than children, so the glyph stays the
     * one thing an icon button draws. */
    badge?: ReactNode;
  };

/** A 20px square glyph control: a pane's close, a toolbar switch, a chip's remove. */
export function IconButton({
  icon,
  label,
  hint,
  detail,
  also,
  badge,
  tone,
  on,
  className,
  type = "button",
  ...rest
}: IconProps) {
  const cls = cx("btn-icon", tone && TONE[tone], on && "on", className);
  return (
    <button className={cls} type={type} {...tip(label, hint, { detail, also })} {...rest}>
      {typeof icon === "string" ? <Icon name={icon} /> : icon}
      {badge}
    </button>
  );
}
