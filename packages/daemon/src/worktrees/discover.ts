// Worktrees git knows about that toyon did not create. `create()` used to be the only door into
// the worktree list, so anything made in a terminal or by another agent was invisible and the
// answer to "where's my stuff" was "you didn't create it in toyon". Here git owns the question of
// what *exists*; state.json stays the sidecar for what toyon adds on top.
//
// Nothing here writes: a discovered worktree is derived on every push and never persisted, which
// is what makes "toyon cannot delete a directory it did not create" structural rather than a rule
// someone has to remember.

import { basename } from "node:path";
import type { DiscoveredWorktree, WorktreeInfo } from "@toyon/shared";
import { canonical } from "../agent/bounds.ts";
import { type GitWorktree, listWorktrees } from "../git/worktrees.ts";

/** The paths toyon already accounts for. Spares are in here too even though `statuses()` filters
 * them out of the rail, or the pre-warmed spare would show up as somebody's stray worktree. The
 * set spans every repo, not just the one being scanned: a worktree of repo A that the user has
 * also registered as its own project is toyon's, and should not be offered for adoption twice. */
function knownPaths(known: WorktreeInfo[]): Set<string> {
  const paths = new Set<string>();
  for (const wt of known) {
    paths.add(canonical(wt.path));
    // the title-named symlink beside a claimed spare: git reports whichever the person used
    if (wt.linkPath) paths.add(canonical(wt.linkPath));
  }
  return paths;
}

/** git's worktree list minus the ones toyon owns. Pure, so the matching rule is testable without
 * a repo: paths are canonicalised on both sides because /tmp is a symlink to /private/tmp on
 * macOS, and a worktree reached through either spelling is the same worktree. */
export function subtractKnown(repoId: string, listed: GitWorktree[], known: WorktreeInfo[]): DiscoveredWorktree[] {
  const mine = knownPaths(known);
  const rows: DiscoveredWorktree[] = [];
  for (const g of listed) {
    // the repository itself, not a place work happens
    if (g.bare) continue;
    // git keeps listing a worktree whose directory is gone; there is nothing to show or adopt
    if (g.prunable) continue;
    if (mine.has(canonical(g.path))) continue;
    rows.push({
      repoId,
      name: g.branch ?? basename(g.path),
      path: g.path,
      ...(g.branch ? { branch: g.branch } : {}),
      ...(g.locked ? { locked: true } : {}),
      ...(g.lockReason ? { lockReason: g.lockReason } : {}),
    });
  }
  return rows;
}

/** What one repo has that toyon does not know about. */
export async function discoverIn(
  repoId: string,
  repoPath: string,
  known: WorktreeInfo[],
): Promise<DiscoveredWorktree[]> {
  return subtractKnown(repoId, await listWorktrees(repoPath), known);
}
