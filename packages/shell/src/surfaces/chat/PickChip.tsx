import type { PickMeta } from "@toyon/shared";
import { Icon } from "../../ui/Icon.tsx";
import { pickLabel, relFile } from "../util.ts";

/** a picked element as a chip: crosshair, <Component>, then file:line. In the composer it can be removed;
 * in the chat it just highlights on hover. The file half is a link wherever there is somewhere to
 * go: a pick keeps pointing at its source long after the message it rode in on. */
export function PickChip({
  pick,
  worktreePath,
  tipText,
  onHover,
  onOpen,
  onRemove,
  className = "",
}: {
  pick: PickMeta;
  worktreePath?: string;
  tipText?: string;
  onHover?: (entering: boolean) => void;
  /** open the source this element was rendered from, at the line the chip names */
  onOpen?: (path: string, line: number) => void;
  onRemove?: () => void;
  className?: string;
}) {
  const file = pick.file ? relFile(pick.file, worktreePath) : null;
  return (
    <div
      className={`pick-chip ${className}`}
      data-tip={tipText}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      <span className="pick-target">
        <Icon name="pick" className="icon-inline" /> {pickLabel(pick)}
        {file && (
          <span className="pick-file">
            {" "}
            ·{" "}
            {onOpen ? (
              <button className="pick-open" data-tip="Open the source" onClick={() => onOpen(file, pick.line ?? 1)}>
                {file}
                {pick.line ? `:${pick.line}` : ""}
              </button>
            ) : (
              `${file}${pick.line ? `:${pick.line}` : ""}`
            )}
          </span>
        )}
      </span>
      {onRemove && (
        <button data-tip="Remove attachment" aria-label="Remove attachment" onClick={onRemove}>
          <Icon name="close" className="icon-inline" />
        </button>
      )}
    </div>
  );
}
