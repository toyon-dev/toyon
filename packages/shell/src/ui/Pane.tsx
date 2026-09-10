import type { ReactNode } from "react";
import { IconButton } from "./Button.tsx";
import "./pane.css";
import { type MenuEntry, useContextMenu } from "./menu.ts";

/** a bottom pane of the preview column (editor, terminal): drag handle, header row, close button.
 * Esc closes them in order from app/keys.ts, which owns the ladder. */
export function Pane({
  className,
  height,
  resizable = true,
  onDragStart,
  title,
  actions,
  menu,
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
  /** what a right-click on the header offers: the thing the pane is showing, as its actions */
  menu?: () => MenuEntry[];
  onClose: () => void;
  closeHint?: string;
  children: ReactNode;
}) {
  const cm = useContextMenu("pane");
  return (
    <div className={`pane ${className}`} style={height === undefined ? undefined : { height }}>
      {resizable && <div className="pane-resize" onPointerDown={onDragStart} />}
      <div className="pane-head" {...cm.contextMenu(() => menu?.() ?? [])}>
        <span className="pane-title">{title}</span>
        {actions}
        <IconButton icon="close" label="Close" hint={closeHint} onClick={onClose} />
      </div>
      {children}
    </div>
  );
}
