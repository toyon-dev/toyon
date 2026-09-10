import type { GitFileStatus } from "@toyon/shared";
import { memo } from "react";
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
  onContext,
  onHover,
}: {
  f: GitFileStatus;
  /** this file's diff is the one open in the editor */
  active: boolean;
  /** the keyboard selection, drawn only while the list has focus */
  selected: boolean;
  onOpen: (path: string) => void;
  onContext: (e: React.MouseEvent, path: string) => void;
  onHover: (path: string, entering: boolean) => void;
}) {
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
      onContextMenu={(e) => onContext(e, f.path)}
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
