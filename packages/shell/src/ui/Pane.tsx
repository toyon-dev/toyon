import type { ReactNode } from "react";
import { IconButton } from "./Button.tsx";
import { tip } from "./Tooltip.tsx";

/** a bottom pane of the preview column (editor, terminal): drag handle, header row, close button.
 * Esc closes them in order from app/keys.ts, which owns the ladder. */
export function Pane({
  className,
  height,
  resizable = true,
  onDragStart,
  title,
  actions,
  onClose,
  closeHint = "esc",
  floating = false,
  children,
}: {
  className: string;
  /** omitted: the pane takes the room the flex column gives it */
  height?: number | string;
  resizable?: boolean;
  onDragStart: (e: React.PointerEvent) => void;
  title?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  closeHint?: string;
  /** the header floats over the top-right corner instead of taking a row (the terminal: its
   * first line is the title) */
  floating?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`pane ${className}`} style={height === undefined ? undefined : { height }}>
      {resizable && <div className="row-resize" onPointerDown={onDragStart} />}
      <div className={`file-head ${floating ? "floating" : ""}`}>
        <span className="file-path">{title}</span>
        {actions}
        <IconButton icon="close" label="Close" hint={closeHint} onClick={onClose} />
      </div>
      {children}
    </div>
  );
}
