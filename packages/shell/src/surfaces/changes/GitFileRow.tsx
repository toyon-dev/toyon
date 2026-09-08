import type { GitFileStatus } from "@toyon/shared";
import { memo } from "react";
import { xyClass, xyLetter } from "../util.ts";

export function LineCounts({ f }: { f: GitFileStatus }) {
  if (f.add === undefined && f.del === undefined) return null;
  return (
    <span className="counts">
      {f.add ? <span className="add">+{f.add}</span> : null}
      {f.del ? <span className="del">−{f.del}</span> : null}
    </span>
  );
}

/** one row of the changes list: status letter, path, +/- counts */
export const GitFileRow = memo(function GitFileRow({
  f,
  active,
  onOpen,
  onContext,
  onHover,
}: {
  f: GitFileStatus;
  /** this file's diff is the one open in the editor */
  active: boolean;
  onOpen: (path: string) => void;
  onContext: (e: React.MouseEvent, path: string) => void;
  onHover: (path: string, entering: boolean) => void;
}) {
  return (
    <button
      className={`git-file ${active ? "active" : ""}`}
      onClick={() => onOpen(f.path)}
      onContextMenu={(e) => onContext(e, f.path)}
      onMouseEnter={() => onHover(f.path, true)}
      onMouseLeave={() => onHover(f.path, false)}
    >
      <span className={`xy ${xyClass(f.xy)}`}>{xyLetter(f.xy)}</span>
      <span className="path">{f.path}</span>
      <LineCounts f={f} />
    </button>
  );
});
