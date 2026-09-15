import type { CommitEntry } from "@toyon/shared";
import { memo } from "react";
import { commitItems } from "../../state/actions/commit.ts";
import { useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
import { ago } from "../util.ts";

/** one row of the history list: the subject, and how long ago it landed.
 *
 * The subject leads and takes the whole row. The sha is what a log usually puts first, but in a
 * 220px dock its seven mono characters cut the subject to about twelve, and the subject is the
 * part anyone scans for; the sha is in the tooltip, and in the diff pane's title once a file from
 * this commit is open. Whether a commit is ahead of main is a section title, not a per-row mark,
 * for the same reason: the runs are contiguous, so saying it once costs no width at all. */
export const CommitRow = memo(function CommitRow({
  c,
  id,
  selected,
  onToggle,
}: {
  c: CommitEntry;
  /** what the list points `aria-activedescendant` at when the cursor is on this row */
  id: string;
  /** the keyboard selection, drawn only while the list has focus. It is the commit's only mark:
   * nothing is open on a commit row, so it is marked exactly when you are on it. Whether it is
   * expanded is not a prop, since the files listed under it say so. */
  selected: boolean;
  onToggle: (sha: string) => void;
}) {
  const cm = useContextMenu("changes");
  return (
    <button
      className="row row-sm log-row row-edge"
      id={id}
      data-state={rowState({ current: selected, cursor: selected })}
      role="option"
      aria-selected={selected}
      // the list owns the keyboard, the same way the changed-files list does
      tabIndex={-1}
      onClick={() => onToggle(c.sha)}
      {...cm.contextMenu(() => commitItems(c))}
      data-tip={`${c.subject}\n${c.short} · ${c.author}`}
      data-tip-placement="follow"
    >
      <span className="subject">{c.subject}</span>
      <span className="at row-dim">{ago(c.at)}</span>
    </button>
  );
});
