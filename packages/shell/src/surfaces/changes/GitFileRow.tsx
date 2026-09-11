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
  active,
  selected,
  onOpen,
  menu,
  onHover,
}: {
  f: GitFileStatus;
  /** the row the list marks, band and edge: where the cursor is while the list has the keyboard,
   * and the file open in the editor while it does not */
  active: boolean;
  /** the keyboard selection, drawn only while the list has focus */
  selected: boolean;
  onOpen: (path: string) => void;
  /** what a right-click on this file offers */
  menu: (path: string) => MenuEntry[];
  onHover: (path: string, entering: boolean) => void;
}) {
  const cm = useContextMenu("changes");
  const { name, dir } = splitPath(f.path);
  return (
    <button
      className="row row-sm git-file row-edge"
      data-state={rowState({ current: active, cursor: selected })}
      role="option"
      aria-selected={selected}
      // the list owns the keyboard: tab reaches the panel, not each of fifty files in it
      tabIndex={-1}
      onClick={() => onOpen(f.path)}
      {...cm.contextMenu(() => menu(f.path))}
      onMouseEnter={() => onHover(f.path, true)}
      onMouseLeave={() => onHover(f.path, false)}
    >
      <span className={`xy ${xyClass(f.xy)}`}>{xyLetter(f.xy)}</span>
      <span className="path" data-tip={dir ? f.path : undefined}>
        <span className="name">{name}</span>
        {dir && <span className="dir row-dim">{dir}</span>}
      </span>
      <LineCounts f={f} />
    </button>
  );
});
