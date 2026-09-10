import { type ReactNode, useRef } from "react";
import { useDismissOutside } from "./hooks.ts";
import "./overlay.css";

/** The palette/prompt frame: scrim over the preview column + a box. Every overlay dismisses the
 * same way (mousedown outside the box, incl. on the docks and rail). `anchored` drops the scrim
 * and the centering: the box becomes a dropdown and the caller renders it inside the trigger's
 * positioned wrapper, so a picker opened from a button lands under that button. */
export function Overlay({
  onClose,
  boxClass = "",
  bare = false,
  anchored = false,
  children,
}: {
  /** absent = the box can't be dismissed (first-run config must be confirmed) */
  onClose?: () => void;
  boxClass?: string;
  /** no box chrome: the children bring their own cards (shortcuts + settings) */
  bare?: boolean;
  /** a dropdown under its trigger rather than a centered overlay; the trigger owns the position */
  anchored?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOutside(ref, () => onClose?.());
  const box = (
    <div className={`${bare ? "" : "overlay-box"} ${anchored ? "anchored" : ""} ${boxClass}`} ref={ref}>
      {children}
    </div>
  );
  return anchored ? box : <div className="overlay">{box}</div>;
}
