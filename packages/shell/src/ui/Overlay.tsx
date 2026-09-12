import { type ReactNode, useRef } from "react";
import { cx } from "./cx.ts";
import { Float, useFloatEntry } from "./Float.tsx";
import "./overlay.css";
import type { Flip } from "./place.ts";

/** How an anchored box sits on the control it belongs to, where that differs from the default: it
 * opens over the control, growing down from its top edge, and lines up on its left. `matchWidth`
 * takes the control's width (the route list is the address field's own box), and `flip` lets it
 * turn over or swap ends when the window has no room that way. */
export type Anchored = { flip?: Flip; margin?: number; matchWidth?: number };

type Props = {
  /** absent = the box can't be dismissed (first-run config must be confirmed) */
  onClose?: () => void;
  /** Escape while this is the topmost float. A box the store owns leaves this alone: its Escape
   * belongs to the ladder in app/keys.ts, which knows what is behind it. */
  onEscape?: () => void;
  boxClass?: string;
  /** no box chrome: the children bring their own cards (shortcuts + settings) */
  bare?: boolean;
  /** a dropdown on the control that opened it, rather than a centred overlay over the preview */
  anchored?: boolean | Anchored;
  /** the part of the box that lands on the control: the panel's own field, so the value it holds
   * does not move when the panel opens over it */
  coverBy?: string;
  /** names the box for the control that says it opens this one (`aria-controls`) */
  id?: string;
  children: ReactNode;
};

/**
 * The palette frame: a scrim over the centre and a box, or a dropdown on the control that
 * opened it. Every overlay dismisses the same way, through the one stack in floats.ts: a press
 * outside it and everything it opened, or a press in the preview, which never reaches this page.
 */
export function Overlay({ anchored = false, ...rest }: Props) {
  return anchored ? <Dropdown {...rest} anchored={anchored === true ? {} : anchored} /> : <Centred {...rest} />;
}

function Dropdown({
  onClose,
  onEscape,
  boxClass = "",
  bare = false,
  anchored,
  coverBy,
  id,
  children,
}: Omit<Props, "anchored"> & { anchored: Anchored }) {
  return (
    <Float
      className={cx(bare ? "" : "overlay-box", "anchored", boxClass)}
      id={id}
      anchor="parent"
      placement={{ side: "bottom", align: "start", cover: true, margin: 0, ...anchored }}
      coverBy={coverBy}
      onDismiss={onClose ? () => onClose() : undefined}
      onKey={onEscape ? escapeOnly(onEscape) : undefined}
    >
      {children}
    </Float>
  );
}

function Centred({ onClose, onEscape, boxClass = "", bare = false, id, children }: Omit<Props, "anchored">) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFloatEntry(ref, {
    onDismiss: onClose ? () => onClose() : undefined,
    onKey: onEscape ? escapeOnly(onEscape) : undefined,
  });
  return (
    <div className="overlay">
      <div className={cx(bare ? "" : "overlay-box", boxClass)} id={id} ref={ref}>
        {children}
      </div>
    </div>
  );
}

/** the stack hands the topmost float every key; a box that only answers Escape ends that one alone */
const escapeOnly = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  fn();
};
