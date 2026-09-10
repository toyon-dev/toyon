import type { ReactNode } from "react";
import { Button, IconButton } from "./Button.tsx";
import "./pane.css";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";
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
  full,
  onToggleFull,
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
   * is the head's height, so the pane's geometry is the same either way. */
  tabs?: Omit<TabsProps<string>, "end">;
  actions?: ReactNode;
  /** what a right-click on the header offers: the thing the pane is showing, as its actions */
  menu?: () => MenuEntry[];
  /** the pane can take the whole column: the toggle sits with the close, since both are about the
   * pane's shape rather than what it shows */
  full?: boolean;
  onToggleFull?: () => void;
  onClose: () => void;
  closeHint?: string;
  children: ReactNode;
}) {
  const cm = useContextMenu("pane");
  const fullToggle = onToggleFull && (
    <Button
      variant="outline"
      tone="quiet"
      mono
      className="deep-link"
      onClick={onToggleFull}
      data-tip={full ? "Split view: show the preview above" : "Full height: hide the preview"}
    >
      <Icon name={full ? "split" : "full"} className="icon-inline" /> {full ? "split" : "full"}
    </Button>
  );
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
                {fullToggle}
                {close}
              </>
            }
          />
        ) : (
          <>
            <span className="pane-title">{title}</span>
            {actions}
            {fullToggle}
            {close}
          </>
        )}
      </div>
      {children}
    </div>
  );
}
