// When a worktree archives itself: it finished, left nothing to keep, nobody is waiting on it, and
// newer work has pushed it down the rail and out of mind. Pure, so the daemon's sweep and its tests
// read the same rule, and every condition errs toward keeping the row.

import { hasOwnBranch, isUnseen, type WorktreeInfo } from "./model.ts";
import { railOrder } from "./railOrder.ts";

/** rows sent to more recently that a worktree needs before it may go: someone with a handful of
 * chats never loses one */
export const ARCHIVE_KEEP_RECENT = 5;

export interface ArchiveFacts {
  now: number;
  /** how long nobody may have opened it */
  afterMs: number;
  /** every worktree record in its repo, main included */
  rows: readonly WorktreeInfo[];
  /** a tab shows it right now */
  viewed: (id: string) => boolean;
  /** its agent is working, asking, or holding a message (queued, steered, refused) */
  pending: (id: string) => boolean;
  /** words wait in its composer box */
  drafted: (id: string) => boolean;
  /** uncommitted files and commits ahead of main; a count not known reads as work */
  counts: (id: string) => { dirty?: number; ahead?: number };
}

/** why the worktree may archive itself now, as the rail will say it; null keeps it */
export function archiveReason(wt: WorktreeInfo, f: ArchiveFacts): string | null {
  // a variant group is compared as one, so it goes as one
  const group = wt.variant ? f.rows.filter((w) => w.variant?.group === wt.variant?.group) : [wt];
  if (!group.every((w) => nothingToKeep(w, f))) return null;
  if (unitsAhead(wt, f.rows) < ARCHIVE_KEEP_RECENT) return null;
  return `${wt.landed ? "landed" : "no changes"}, not opened in ${duration(f.afterMs)}`;
}

function nothingToKeep(w: WorktreeInfo, f: ArchiveFacts): boolean {
  // toyon's own task on toyon's own branch: an adopted directory is the person's, and archiving
  // deletes it
  if (w.kind !== "worktree" || !hasOwnBranch(w)) return false;
  // finished cleanly and read: a stop, a failure or a question is a row someone has to come back to
  if (w.lastTurn?.end !== "done" || isUnseen(w)) return false;
  // a plan it showed is worth keeping whatever became of it, and an open PR is work under review
  if (w.planned || w.pr?.state === "open") return false;
  if (f.viewed(w.id) || f.pending(w.id) || f.drafted(w.id)) return false;
  if (f.now - (w.viewedAt ?? w.createdAt) < f.afterMs) return false;
  const c = f.counts(w.id);
  return c.dirty === 0 && c.ahead === 0;
}

/** how many rail units (a row, or a variant group) sit above this one, main aside */
function unitsAhead(wt: WorktreeInfo, rows: readonly WorktreeInfo[]): number {
  const tasks = railOrder(rows.filter((w) => w.kind === "worktree").map((worktree) => ({ worktree })));
  const seen = new Set<string>();
  for (const { worktree: w } of tasks) {
    const unit = w.variant?.group ?? w.id;
    if (unit === (wt.variant?.group ?? wt.id)) return seen.size;
    seen.add(unit);
  }
  return seen.size;
}

function duration(ms: number): string {
  if (ms >= 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}
