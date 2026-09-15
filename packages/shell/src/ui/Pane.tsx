import type { ReactNode } from "react";
import { Button, IconButton } from "./Button.tsx";
import "./pane.css";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";
import { type MenuEntry, useContextMenu } from "./menu.ts";
import { Tabs, type TabsProps } from "./Tabs.tsx";

/**
 * A pane: stacked inside the centre, resizable, closable, with a header row and a drag handle,
 * and on the Esc ladder that app/keys.ts owns. Exactly three things are one, the editor, the
 * design pane and the terminal, and Center.tsx counts them as `:scope > .pane` when it works out
 * how much room a drag has left.
 *
 * Nothing else is a pane. The views that stand in for the preview fill the centre whole and have
 * no header, no handle and no height of their own; the bar at the top of the window is a bar. For
 * years seven of those views were named `*Pane` and rendered none of this, which is the drift this
 * paragraph exists to stop.
 */
export type PaneKind = "editor" | "design" | "terminal";

export function Pane({
  kind,
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
  /** which pane this is, so Escape closes the one holding the keyboard rather than the first open */
  kind: PaneKind;
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
    // Focusable but out of the tab order: a click on the pane's own ground (the design pane is
    // mostly that) otherwise drops focus on the body, and Escape could not tell which pane was meant
    <div
      className={`pane ${className}`}
      data-pane={kind}
      tabIndex={-1}
      style={height === undefined ? undefined : { height }}
    >
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
