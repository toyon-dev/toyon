import { type ReactNode, type RefObject, useRef } from "react";
import { useDismissOutside } from "./hooks.ts";

/** The palette/prompt frame: scrim over the preview column + a box. Every overlay dismisses the
 * same way (mousedown outside the box, incl. on the docks and rail). */
export function Overlay({
  onClose,
  boxClass = "",
  boxRef,
  children,
}: {
  /** absent = the box can't be dismissed (first-run config must be confirmed) */
  onClose?: () => void;
  boxClass?: string;
  boxRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = boxRef ?? own;
  useDismissOutside(ref, () => onClose?.());
  return (
    <div className="prompt-overlay">
      <div className={`prompt-box ${boxClass}`} ref={ref}>
        {children}
      </div>
    </div>
  );
}
