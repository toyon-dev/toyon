// When a worktree archives itself: it finished, left nothing to keep, nobody is waiting on it, and
// newer work has pushed it down the rail and out of mind. Pure, so the daemon's sweep and its tests
// read the same rule, and every condition errs toward keeping the row. What the row holds is one
// question (`heldBy`), asked by the sweep before it archives and by the shell before it confirms an
// archive someone pressed for, so the two never disagree about what is worth a second look.

import { hasOwnBranch, isUnseen, type WorktreeInfo } from "./model.ts";
import { railOrder } from "./railOrder.ts";

/** rows sent to more recently that a worktree needs before it may go: someone with a handful of
 * chats never loses one */
export const ARCHIVE_KEEP_RECENT = 5;

/** how long nobody may have opened a row whose box holds a draft: a week, where an empty box waits
 * hours. The draft is kept with the archive and listed by it, so the wait is only how long the
 * note stays among this week's work. */
export const ARCHIVE_DRAFT_AFTER_MS = 7 * 24 * 60 * 60_000;

/** what the record alone cannot say about a row: the facts whoever asks reads off their own side */
export interface KeepFacts {
  /** its agent is working, asking, or holding a message (queued, steered, refused) */
  pending: (id: string) => boolean;
  /** uncommitted files and commits ahead of main; a count not known reads as work */
  counts: (id: string) => { dirty?: number; ahead?: number };
}

export interface ArchiveFacts extends KeepFacts {
  now: number;
  /** how long nobody may have opened it */
  afterMs: number;
  /** words or an attachment wait in its composer box */
  drafted: (id: string) => boolean;
  /** how long nobody may have opened it when its box holds a draft; never shorter than `afterMs` */
  draftAfterMs: number;
  /** every worktree record in its repo, main included */
  rows: readonly WorktreeInfo[];
  /** a tab shows it right now */
  viewed: (id: string) => boolean;
}

/** What the worktree holds that archiving would take out of reach, as a clause a question can
 * say ("its agent is still busy"), or null when it holds nothing. The concrete first: what git
 * counts, then the agent, then how the last turn ended and what it showed. A draft is not here:
 * an archive keeps it in its box and lists the row by it. */
export function heldBy(w: WorktreeInfo, f: KeepFacts): string | null {
  const c = f.counts(w.id);
  if (c.dirty === undefined || c.ahead === undefined) return "its changes are not counted yet";
  if (c.dirty > 0) return "it has uncommitted changes";
  if (c.ahead > 0) return "it has commits not on main";
  if (f.pending(w.id)) return "its agent is still busy";
  // landed settles the rest: the work is on main, and archiving keeps the chat and its plans
  if (w.landed) return null;
  // finished cleanly and read: a stop, a failure or a question is a row someone has to come back to
  const end = w.lastTurn?.end;
  if (!end) return "its agent has not run yet";
  if (end === "stopped") return "its last turn was stopped";
  if (end === "failed") return "its last turn failed";
  if (end === "asking") return "its agent is waiting on an answer";
  if (isUnseen(w)) return "its last reply is unread";
  // a plan it showed is worth keeping whatever became of it, and an open PR is work under review
  if (w.planned) return "it showed a plan";
  if (w.pr?.state === "open") return "its pull request is still open";
  return null;
}

/** why the worktree may archive itself now, as the rail will say it; null keeps it */
export function archiveReason(wt: WorktreeInfo, f: ArchiveFacts): string | null {
  if (!nothingToKeep(wt, f)) return null;
  if (rowsAhead(wt, f.rows) < ARCHIVE_KEEP_RECENT) return null;
  const what = wt.landed ? "landed" : "no changes";
  return `${what}, ${UNOPENED}${duration(waitOf(wt, f))}`;
}

/** how long nobody may have opened this row before it goes: longer while its box holds a draft */
function waitOf(w: WorktreeInfo, f: ArchiveFacts): number {
  return f.drafted(w.id) ? Math.max(f.afterMs, f.draftAfterMs) : f.afterMs;
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
  if (f.viewed(w.id)) return false;
  if (f.now - (w.viewedAt ?? w.createdAt) < waitOf(w, f)) return false;
  return heldBy(w, f) === null;
}

/** how many rows sit above this one, main aside */
function rowsAhead(wt: WorktreeInfo, rows: readonly WorktreeInfo[]): number {
  const tasks = railOrder(rows.filter((w) => w.kind === "worktree").map((worktree) => ({ worktree })));
  const at = tasks.findIndex(({ worktree: w }) => w.id === wt.id);
  return at < 0 ? tasks.length : at;
}

function duration(ms: number): string {
  if (ms >= 24 * 60 * 60_000) return `${Math.round(ms / (24 * 60 * 60_000))}d`;
  if (ms >= 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}
