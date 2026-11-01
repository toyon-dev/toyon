import type { RepoInfo, WorktreeInfo, WorktreeStatus } from "./model.ts";
import { isLead, isOwned } from "./worktree-caps.ts";

/** when someone last put work into a row: what they sent, else its agent's last turn for a row from
 * before sends were stamped, else when it was made */
export const sentAt = (w: WorktreeInfo) => w.promptedAt ?? w.lastTurn?.at ?? w.createdAt;

/** where a row sits in the rail's order: the lead (the spare, or main without one), then everything
 * else */
const tierOf = (w: WorktreeInfo) => (isLead(w) ? 0 : 1);

/** The rail's order: the lead, then the rows most recently sent to. A row moves when a hand puts
 * work into it or through it: a send, or a land press that did something (created a PR, pushed to
 * one, landed on main). A landed row at the top reads as the next thing to archive, and the ones
 * below it are the live work. Nothing else moves a row, not an agent finishing or asking and not
 * the poll landing a PR merged on GitHub: nothing slides out from under the pointer on its own,
 * and what needs you is the dot's and the jump chord's to say. Rows that tie keep the daemon's
 * order. */
export function railOrder<T extends { worktree: WorktreeInfo }>(rows: readonly T[]): T[] {
  // stable, so a tie is the daemon's order
  return [...rows].sort((a, b) => tierOf(a.worktree) - tierOf(b.worktree) || sentAt(b.worktree) - sentAt(a.worktree));
}

/** The project picker's order: the rail's rule one level up. A project sits at its newest
 * worktree send, so the one last worked in is first and one left for weeks sinks, and only a send
 * moves it: opening the picker to look at a project does not reorder the list for next time. The
 * project keeps the send of each row that left it, so landing and archiving every row leaves it
 * where the work put it rather than at the bottom; the open rows carry their own. The spare is
 * left out, since it is made when a project is opened and looking is not working; main's creation
 * stands in for a project with no send yet, which puts a project just registered near the top,
 * where someone who just opened it expects it. Ties keep the daemon's order, so projects whose
 * rows are not loaded (another machine still connecting) list as the daemon does. */
export function projectOrder(repos: readonly RepoInfo[], rows: readonly WorktreeStatus[]): RepoInfo[] {
  const at = new Map<string, number>();
  for (const repo of repos) at.set(repo.id, repo.promptedAt ?? 0);
  for (const row of rows) {
    if (!isOwned(row) || row.worktree.kind === "spare") continue;
    const id = row.worktree.repoId;
    at.set(id, Math.max(at.get(id) ?? 0, sentAt(row.worktree)));
  }
  // stable, so a tie is the daemon's order
  return [...repos].sort((a, b) => (at.get(b.id) ?? 0) - (at.get(a.id) ?? 0));
}
