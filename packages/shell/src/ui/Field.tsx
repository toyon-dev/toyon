import type { ComponentProps } from "react";
import { cx } from "./cx.ts";
import "./field.css";

/**
 * Every input and textarea in the app, across three closed axes: size, font, `bare`.
 *
 * Counted, like Button's, rather than designed. Five surface rules had each changed the box or the
 * face of `.field` on their own: the form's 5px padding, the palette's mono face on a prose-sized
 * box, the anchored strip's stripped border, the composer's bare textarea, the ask note's ui face.
 * Those are three sizes, two faces and one treatment, and nothing else ever varied.
 *
 * The face follows the size unless told otherwise: an identifier box (sm, md) holds a path, a
 * branch, a command, which are literals the person also types elsewhere, so it is mono; a prose
 * box (lg) holds what they write, so it is ui. The palette says `font="mono"` on its prose-sized
 * box because a filter is an identifier, and the ask note says `font="ui"` on its small one.
 */
export type FieldSize = "sm" | "md" | "lg";
export type FieldFont = "mono" | "ui";

const SIZE: Record<FieldSize, string> = {
  /** an identifier in a row: the auth key, the address strip */
  sm: "",
  /** a form's input, tall enough to point at */
  md: "field-md",
  /** prose: the composer, the commit message, the palette */
  lg: "field-lg",
};

type Shared = {
  size?: FieldSize;
  font?: FieldFont;
  /** no box of its own, because the region it sits in is the box: the composer, an anchored picker's strip */
  bare?: boolean;
  /** how the field sits in its parent (flex, width, margin). Never its box or its face. */
  className?: string;
};

function classes({ size = "sm", font, bare, className }: Shared): string {
  const face = font ?? (size === "lg" ? "ui" : "mono");
  return cx("field", SIZE[size], face === "ui" && "field-ui", bare && "field-bare", className);
}

export function Field({ size, font, bare, className, ...rest }: Omit<ComponentProps<"input">, "size"> & Shared) {
  return <input className={classes({ size, font, bare, className })} {...rest} />;
}

export function TextArea({ size, font, bare, className, ...rest }: ComponentProps<"textarea"> & Shared) {
  return <textarea className={classes({ size, font, bare, className })} {...rest} />;
}
