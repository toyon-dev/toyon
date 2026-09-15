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
  const group = wt.variant ? f.rows.filter((w) => w.variant?.group === wt.variant?.group) : [wt];
  // once one attempt has landed the group is decided, and each of the others is an attempt it beat
  const decided = group.some((w) => !!w.lands?.length);
  const lost = decided && !wt.lands?.length;
  if (decided) {
    if (!nothingToKeep(wt, f, lost)) return null;
    // a group still being compared is compared as one, so it goes as one
  } else if (!group.every((w) => nothingToKeep(w, f, false))) return null;
  if (unitsAhead(wt, f.rows) < ARCHIVE_KEEP_RECENT) return null;
  const what = lost ? "a sibling landed" : wt.landed ? "landed" : "no changes";
  return `${what}, not opened in ${duration(f.afterMs)}`;
}

/** `lost`: the commits are an attempt a sibling beat, which the archive keeps for a later cherry-pick,
 * so only work left uncommitted since holds the row */
function nothingToKeep(w: WorktreeInfo, f: ArchiveFacts, lost: boolean): boolean {
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
  return c.dirty === 0 && (lost ? c.ahead !== undefined : c.ahead === 0);
}

/** how many rail units sit above this one, main aside: a row, or a variant group on one tier, since
 * the rail files a landed attempt with landed work and the ones it beat where they were */
function unitsAhead(wt: WorktreeInfo, rows: readonly WorktreeInfo[]): number {
  const unitOf = (w: WorktreeInfo) => (w.variant ? `${w.landed ? "landed" : "open"}:${w.variant.group}` : w.id);
  const tasks = railOrder(rows.filter((w) => w.kind === "worktree").map((worktree) => ({ worktree })));
  const seen = new Set<string>();
  for (const { worktree: w } of tasks) {
    const unit = unitOf(w);
    if (unit === unitOf(wt)) return seen.size;
    seen.add(unit);
  }
  return seen.size;
}

function duration(ms: number): string {
  if (ms >= 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}
