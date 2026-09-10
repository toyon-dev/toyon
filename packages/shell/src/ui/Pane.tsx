import type { ReactNode } from "react";
import { IconButton } from "./Button.tsx";
import "./pane.css";
import { cx } from "./cx.ts";
import { type MenuEntry, useContextMenu } from "./menu.ts";
import { Tabs, type TabsProps } from "./Tabs.tsx";

/** a bottom pane of the preview column (editor, terminal): drag handle, header row, close button.
 * Esc closes them in order from app/keys.ts, which owns the ladder. */
export function Pane({
  className,
  height,
  resizable = true,
  onDragStart,
  title,
  tabs,
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
  /** a strip of alternatives as the header instead of a title: the terminal's streams. The strip
   * is the row height, the same as the head, so the pane's geometry is the same either way. */
  tabs?: Omit<TabsProps<string>, "end">;
  actions?: ReactNode;
  /** what a right-click on the header offers: the thing the pane is showing, as its actions */
  menu?: () => MenuEntry[];
  onClose: () => void;
  closeHint?: string;
  children: ReactNode;
}) {
  const cm = useContextMenu("pane");
  const close = <IconButton icon="close" label="Close" hint={closeHint} onClick={onClose} />;
  return (
    <div className={`pane ${className}`} style={height === undefined ? undefined : { height }}>
      {resizable && <div className="pane-resize" onPointerDown={onDragStart} />}
      <div className={cx("pane-head", tabs && "pane-head-tabs")} {...cm.contextMenu(() => menu?.() ?? [])}>
        {tabs ? (
          <Tabs
            {...tabs}
            end={
              <>
                {actions}
                {close}
              </>
            }
          />
        ) : (
          <>
            <span className="pane-title">{title}</span>
            {actions}
            {close}
          </>
        )}
      </div>
      {children}
    </div>
  );
}
