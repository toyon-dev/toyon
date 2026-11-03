import type { GitFileStatus } from "@toyon/shared";
import { type DragEvent, memo } from "react";
import { useTowardCentre } from "../../state/selectors.ts";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
import { useCarries } from "../chat/carried.ts";
import { splitPath, xyClass, xyLetter } from "../util.ts";

export function LineCounts({ f }: { f: GitFileStatus }) {
  if (f.add === undefined && f.del === undefined) return null;
  return (
    <span className="counts">
      {f.add ? <span className="add">+{f.add}</span> : null}
      {f.del ? <span className="del">−{f.del}</span> : null}
    </span>
  );
}

/** one row of the changes list: status letter, file name, its directory, +/- counts */
export const GitFileRow = memo(function GitFileRow({
  f,
  id,
  active,
  selected,
  checking = false,
  checked = false,
  onOpen,
  onCheck,
  menu,
  onHover,
  onDragStart,
  onDragEnd,
}: {
  f: GitFileStatus;
  /** what the list points `aria-activedescendant` at when the cursor is on this row */
  id: string;
  /** the row the list marks, band and edge: where the cursor is while the list has the keyboard,
   * and the file open in the editor while it does not */
  active: boolean;
  /** the keyboard selection, drawn only while the list has focus */
  selected: boolean;
  /** the list is picking files to act on together, and this row is one it can pick: a box shows
   * before the letter, and a click checks rather than opens */
  checking?: boolean;
  /** a member of that pick */
  checked?: boolean;
  onOpen: (path: string) => void;
  /** check or uncheck this row; a shift-click starts the pick from a row that has none showing */
  onCheck?: (path: string) => void;
  /** what a right-click on this file offers */
  menu: (path: string) => MenuEntry[];
  onHover: (path: string, entering: boolean) => void;
  /** the row dragged, to be dropped on the chat as its mention; a list with no worktree to name
   * offers no drag */
  onDragStart?: (path: string, e: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const cm = useContextMenu("changes");
  const carries = useCarries();
  const tipSide = useTowardCentre("changes");
  const { name, dir } = splitPath(f.path);
  return (
    <button
      className="row row-sm git-file row-edge"
      id={id}
      data-state={rowState({ current: active, cursor: selected, checked })}
      role="option"
      aria-selected={selected}
      // the list owns the keyboard: tab reaches the panel, not each of fifty files in it
      tabIndex={-1}
      onClick={(e) => (onCheck && (checking || e.shiftKey) ? onCheck(f.path) : onOpen(f.path))}
      draggable={carries && !!onDragStart}
      onDragStart={onDragStart && ((e) => onDragStart(f.path, e))}
      onDragEnd={onDragEnd}
      {...cm.contextMenu(() => menu(f.path))}
      onMouseEnter={() => onHover(f.path, true)}
      onMouseLeave={() => onHover(f.path, false)}
      // the whole path, on the row rather than on the label: a tip beside its anchor hangs off
      // the anchor's edge, and the label's edge is inside the dock behind the status letter
      data-tip={dir ? f.path : undefined}
      data-tip-placement={tipSide}
    >
      {checking && <input type="checkbox" className="changes-check" checked={checked} readOnly tabIndex={-1} />}
      <span className={`xy ${xyClass(f.xy)}`}>{xyLetter(f.xy)}</span>
      <span className="path">
        <span className="name">{name}</span>
        {dir && <span className="dir row-dim">{dir}</span>}
      </span>
      <LineCounts f={f} />
    </button>
  );
});
