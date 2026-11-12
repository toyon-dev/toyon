import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button.tsx";
import "./pane.css";
import { cx } from "./cx.ts";
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

/** Whether the pane of this kind has the column to itself or the keyboard in it: the pane a key
 * pressed now is about, rather than the page above it. Read off the page, since a pane's shape is
 * the centre's own and focus is the browser's. */
export function paneInHand(kind: PaneKind): boolean {
  const pane = document.querySelector<HTMLElement>(`.pane[data-pane="${kind}"]`);
  return !!pane && (pane.classList.contains("full") || pane.contains(document.activeElement));
}

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
  headIn,
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
  /** an element outside the pane that holds its head: the window's title strip, for a pane the
   * window was given to, so the pane's first row is its content. The head is in flow there and
   * covers nothing, which is why this is a portal and not a float. */
  headIn?: HTMLElement | null;
  children: ReactNode;
}) {
  const cm = useContextMenu("pane");
  // a toolbar switch beside the close, seated while the pane has the column: the head's words
  // are left to what the pane shows
  const fullToggle = onToggleFull && (
    <IconButton
      icon="full"
      tone="chrome"
      on={full}
      aria-pressed={!!full}
      label="Full height: hide the preview"
      onClick={onToggleFull}
    />
  );
  // the pane's own controls sit together at the end: both are about the pane's shape, and a gap
  // keeps them apart from what the pane's content put in the head
  const shape = (
    <span className="pane-shape">
      {fullToggle}
      <IconButton icon="close" label="Close" hint={closeHint} onClick={onClose} />
    </span>
  );
  const head = (
    <div className={cx("pane-head", tabs && "pane-head-tabs")} {...cm.contextMenu(() => menu?.() ?? [])}>
      {tabs ? (
        <Tabs
          {...tabs}
          end={
            <>
              {actions}
              {shape}
            </>
          }
        />
      ) : (
        <>
          <span className="pane-title">{title}</span>
          {actions}
          {shape}
        </>
      )}
    </div>
  );
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
      {headIn ? createPortal(head, headIn) : head}
      {children}
    </div>
  );
}
