import type { ReactNode } from "react";
import { tip } from "./Tooltip.tsx";

/** A bottom pane of the preview column (the editor, the terminal): a drag handle on its top edge,
 * a header row with a title and actions, and a close button. Esc closes the open panes in order
 * (app/keys.ts owns that ladder, since it reads the store). */
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
  title: ReactNode;
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
