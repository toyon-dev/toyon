import type { PickMeta } from "@toyon/shared";
import { pickLabel, relFile } from "../util.ts";

/** a picked element as a chip: ⌖ <Component> · file:line. In the composer it can be removed;
 * in the chat it just highlights on hover. */
export function PickChip({
  pick,
  worktreePath,
  tipText,
  onHover,
  onRemove,
  className = "",
}: {
  pick: PickMeta;
  worktreePath?: string;
  tipText?: string;
  onHover?: (entering: boolean) => void;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`pick-chip ${className}`}
      data-tip={tipText}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      <span className="pick-target">
        ⌖ {pickLabel(pick)}
        {pick.file && (
          <span className="pick-file">
            {" "}
            · {relFile(pick.file, worktreePath)}
            {pick.line ? `:${pick.line}` : ""}
          </span>
        )}
      </span>
      {onRemove && (
        <button data-tip="Remove attachment" aria-label="Remove attachment" onClick={onRemove}>
          ✕
        </button>
      )}
    </div>
  );
}
