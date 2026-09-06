import type { ReactNode } from "react";
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
  children: ReactNode;
}) {
  return (
    <div className={`pane ${className}`} style={height === undefined ? undefined : { height }}>
      {resizable && <div className="row-resize" onPointerDown={onDragStart} />}
      <div className="file-head">
        <span className="file-path">{title}</span>
        {actions}
        <button onClick={onClose} {...tip("Close", closeHint)}>
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}
