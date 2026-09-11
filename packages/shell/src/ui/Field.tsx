import { type ComponentProps, forwardRef } from "react";
import { cx } from "./cx.ts";
import "./field.css";

/**
 * Every input and textarea in the app, across three closed axes: size, font, `bare`.
 *
 * The face follows the size unless told otherwise: an identifier box (sm, md) holds a path, a
 * branch, a command, which are literals the person also types elsewhere, so it is mono; a prose
 * box (lg) holds what they write, so it is ui. A picker's filter says `font="mono"` because a filter
 * is an identifier, and the ask note says `font="ui"` on its small box. `lead` is the one question a
 * page asks, typed at the size its answer is read at afterwards: the new-project page's name.
 */
export type FieldSize = "sm" | "md" | "lg";
export type FieldFont = "mono" | "ui" | "lead";

const SIZE: Record<FieldSize, string> = {
  /** an identifier in a row: the auth key, the address strip */
  sm: "",
  /** a form's input, tall enough to point at */
  md: "field-md",
  /** prose: the composer, the commit message */
  lg: "field-lg",
};

type Shared = {
  size?: FieldSize;
  font?: FieldFont;
  /** no box of its own, because the region it sits in is the box: the composer, a picker's strip */
  bare?: boolean;
  /** how the field sits in its parent (flex, width, margin). Never its box or its face. */
  className?: string;
};

function classes({ size = "sm", font, bare, className }: Shared): string {
  const face = font ?? (size === "lg" ? "ui" : "mono");
  return cx(
    "field",
    SIZE[size],
    face === "ui" && "field-ui",
    face === "lead" && "field-lead",
    bare && "field-bare",
    className,
  );
}

// forwardRef, because on React 18 a function component is handed no `ref` at all: it is not in
// the props, so spreading `...rest` onto the element drops it without a type error. The picker's
// focus-on-mount, the composer's caret placement and the prompt's field all reach in this way.
export const Field = forwardRef<HTMLInputElement, Omit<ComponentProps<"input">, "size"> & Shared>(function Field(
  { size, font, bare, className, ...rest },
  ref,
) {
  return <input ref={ref} className={classes({ size, font, bare, className })} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea"> & Shared>(function TextArea(
  { size, font, bare, className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={classes({ size, font, bare, className })} {...rest} />;
});
