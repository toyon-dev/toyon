import type { GitFileStatus } from "@toyon/shared";
import { memo } from "react";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
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
}) {
  const cm = useContextMenu("changes");
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
      {...cm.contextMenu(() => menu(f.path))}
      onMouseEnter={() => onHover(f.path, true)}
      onMouseLeave={() => onHover(f.path, false)}
    >
      {checking && <input type="checkbox" className="changes-check" checked={checked} readOnly tabIndex={-1} />}
      <span className={`xy ${xyClass(f.xy)}`}>{xyLetter(f.xy)}</span>
      <span className="path" data-tip={dir ? f.path : undefined}>
        <span className="name">{name}</span>
        {dir && <span className="dir row-dim">{dir}</span>}
      </span>
      <LineCounts f={f} />
    </button>
  );
});
