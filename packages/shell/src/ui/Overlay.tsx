import { type ReactNode, useRef } from "react";
import { useDismissOutside } from "./hooks.ts";

/** The palette/prompt frame: scrim over the preview column + a box. Every overlay dismisses the
 * same way (mousedown outside the box, incl. on the docks and rail). */
export function Overlay({
  onClose,
  boxClass = "",
  bare = false,
  children,
}: {
  /** absent = the box can't be dismissed (first-run config must be confirmed) */
  onClose?: () => void;
  boxClass?: string;
  /** no box chrome: the children bring their own cards (shortcuts + settings) */
  bare?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOutside(ref, () => onClose?.());
  return (
    <div className="prompt-overlay">
      <div className={`${bare ? "" : "prompt-box"} ${boxClass}`} ref={ref}>
        {children}
      </div>
    </div>
  );
}
