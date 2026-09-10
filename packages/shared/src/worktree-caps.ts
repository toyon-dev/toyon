// What may be done to a worktree, as questions with names. `kind` says what a worktree is (git's
// main checkout, a linked one, a pre-warmed spare); these say what an action may do to it, and the
// two are not the same question. "Not main" stood in for can-remove, can-rename, can-land and
// can-graft at a dozen sites, and they only agreed because every non-main record was a task toyon
// had made. An adopted worktree broke rename, which would have moved the person's branch under a
// toyon/ name, and a pulled-in PR breaks land, since landing a review means something else.

import { hasOwnBranch, type OwnedWorktree, type WorktreeInfo, type WorktreeStatus } from "./model.ts";

type Wt = Pick<WorktreeInfo, "kind" | "branch" | "from">;

/** toyon has a record for this row: something runs here, and something may write here */
export function isOwned(row: WorktreeStatus): row is OwnedWorktree {
  return row.worktree !== undefined;
}

/** git's own main checkout: the baseline everything else is counted against */
export function isMain(wt: Pick<WorktreeInfo, "kind">): boolean {
  return wt.kind === "main";
}

/** the directory and branch may go. A spare is removed by the pool, never by a person. */
export function canRemove(wt: Pick<WorktreeInfo, "kind">): boolean {
  return wt.kind === "worktree";
}

/** rename moves the branch to toyon/<title>, so only a branch that already is toyon's */
export function canRename(wt: Wt): boolean {
  return wt.kind === "worktree" && hasOwnBranch(wt);
}

/** merge into main, or push and open a PR. A worktree opened to review a PR is landed upstream,
 * not here, and offering it would push a pr/<n> branch nobody asked for. */
export function canLand(wt: Wt): boolean {
  return wt.kind === "worktree" && wt.from?.kind !== "pr";
}

/** may be a graft's target or one of its sources */
export function canGraft(wt: Pick<WorktreeInfo, "kind">): boolean {
  return wt.kind === "worktree";
}
