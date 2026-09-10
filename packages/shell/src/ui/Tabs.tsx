import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cx } from "./cx.ts";
import { step } from "./listNav.ts";
import { type MenuEntry, useContextMenu } from "./menu.ts";
import { rowState } from "./rowState.ts";
import type { tip } from "./Tooltip.tsx";
import "./tabs.css";

/** one tab: a label, and the two slots either side of it */
export type TabItem<Id extends string> = {
  id: Id;
  label: ReactNode;
  /** before the label: the proc's status dot */
  lead?: ReactNode;
  /** after the label, on the open tab only: the stream's restart. The tab grows to hold it when
   * it opens, which is the honest shape: the control exists for the stream you are looking at. A
   * sibling of the tab's own button floated over its end rather than a child, since a button
   * cannot hold one, and the tab's button stays the whole tab. */
  trail?: ReactNode;
  tip?: ReturnType<typeof tip>;
  /** what a right-click on the tab offers */
  menu?: () => MenuEntry[];
};

export type TabsProps<Id extends string> = {
  items: TabItem<Id>[];
  current: Id;
  onPick: (id: Id) => void;
  /** the tabs share the strip's width evenly; otherwise each takes its label's width and the rest
   * of the strip stays sunken */
  fill?: boolean;
  /** mono for a strip of literals the person typed somewhere else (proc names); ui for labels */
  font?: "ui" | "mono";
  /** a cluster on the strip's far end, outside the scrolling list: a pane's close */
  end?: ReactNode;
  /** the strip's accessible name */
  label: string;
  /** whose context menu the tabs open */
  owner: string;
};

/**
 * A strip of alternatives with one open. The open tab is painted in the ground of whatever sits
 * under the strip (`--tabs-ground`, set by the parent beside its own background) and the rule
 * under the strip breaks there, so the tab reads as joined to its content rather than as a
 * pressed button. The others sit on the sunken tone. That is the whole mark: no accent, no seat,
 * because the tab metaphor already says which one you are on.
 *
 * The strip is the dense row height, the pane head's, so a strip standing in for a pane's header
 * changes no geometry.
 * Current is `data-state` on the tab, the same word a row uses; `aria-selected` on the button is
 * for the reader. A tab never takes Button's `on`: that is a toggle's accent.
 */
export function Tabs<Id extends string>({ items, current, onPick, fill, font, end, label, owner }: TabsProps<Id>) {
  const cm = useContextMenu(owner);
  const list = useRef<HTMLDivElement>(null);
  // roving tabindex: the open tab is the one in the tab order, and the arrows move between them
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = items.findIndex((it) => it.id === current);
    const next = items[step(i, e.key === "ArrowRight" ? 1 : -1, items.length)];
    if (!next) return;
    onPick(next.id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[items.indexOf(next)]?.focus();
  };
  return (
    <div className={cx("tabs", fill && "tabs-fill", font === "mono" && "tabs-mono")}>
      <div className="tabs-list" role="tablist" aria-label={label} ref={list} onKeyDown={onKeyDown}>
        {items.map((it) => {
          const open = it.id === current;
          return (
            <div
              key={it.id}
              className={cx("tab", open && !!it.trail && "tab-trailed")}
              data-state={rowState({ current: open })}
              {...(it.menu ? cm.contextMenu(it.menu) : {})}
            >
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected={open}
                tabIndex={open ? 0 : -1}
                onClick={() => onPick(it.id)}
                {...it.tip}
              >
                {it.lead}
                {it.label}
              </button>
              {open && it.trail && <span className="tab-trail">{it.trail}</span>}
            </div>
          );
        })}
      </div>
      {end && <span className="tabs-end">{end}</span>}
    </div>
  );
}
