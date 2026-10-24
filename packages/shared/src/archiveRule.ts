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
  if (!nothingToKeep(wt, f)) return null;
  if (rowsAhead(wt, f.rows) < ARCHIVE_KEEP_RECENT) return null;
  const what = wt.landed ? "landed" : "no changes";
  return `${what}, ${UNOPENED}${duration(f.afterMs)}`;
}

const UNOPENED = "not opened in ";

/** a reason split at the wait it ends on: how the work went ("no changes") and how long nobody
 * opened it ("2h"), so a line can lead with the wait and drop what its row already says. All `what`
 * when it does not end on one */
export function archiveParts(reason: string): { what: string; idle?: string } {
  const at = reason.lastIndexOf(UNOPENED);
  if (at < 0) return { what: reason };
  return { what: reason.slice(0, at).replace(/,\s*$/, ""), idle: reason.slice(at + UNOPENED.length) };
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

/** how many rows sit above this one, main aside */
function rowsAhead(wt: WorktreeInfo, rows: readonly WorktreeInfo[]): number {
  const tasks = railOrder(rows.filter((w) => w.kind === "worktree").map((worktree) => ({ worktree })));
  const at = tasks.findIndex(({ worktree: w }) => w.id === wt.id);
  return at < 0 ? tasks.length : at;
}

function duration(ms: number): string {
  if (ms >= 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}
