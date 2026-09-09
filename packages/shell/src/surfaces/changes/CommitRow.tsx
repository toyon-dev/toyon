import type { CommitEntry } from "@toyon/shared";
import { memo } from "react";

/** Coarse on purpose: the question a history row answers is "how long ago", and a row this narrow
 * has no space for a date the reader would have to parse anyway. */
function ago(at: number): string {
  const secs = Math.max(0, (Date.now() - at) / 1000);
  if (secs < 60) return "now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}

/** one row of the history list: the subject, and how long ago it landed.
 *
 * The subject leads and takes the whole row. The sha is what a log usually puts first, but in a
 * 220px dock its seven mono characters cut the subject to about twelve, and the subject is the
 * part anyone scans for; the sha is in the tooltip, and in the diff pane's title once a file from
 * this commit is open. Whether a commit is ahead of main is a section title, not a per-row mark,
 * for the same reason: the runs are contiguous, so saying it once costs no width at all. */
export const CommitRow = memo(function CommitRow({
  c,
  open,
  selected,
  onToggle,
}: {
  c: CommitEntry;
  /** expanded: this commit's files are listed under it */
  open: boolean;
  /** the keyboard selection, drawn only while the list has focus */
  selected: boolean;
  onToggle: (sha: string) => void;
}) {
  return (
    <button
      className={`commit-row row-edge ${open ? "open" : ""} ${selected ? "sel" : ""}`}
      role="option"
      aria-selected={selected}
      // the list owns the keyboard, the same way the changed-files list does
      tabIndex={-1}
      onClick={() => onToggle(c.sha)}
      data-tip={`${c.subject}\n${c.short} · ${c.author}`}
    >
      <span className="subject">{c.subject}</span>
      <span className="at">{ago(c.at)}</span>
    </button>
  );
});
