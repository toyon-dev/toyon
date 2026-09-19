// Worktrees git knows about that toyon did not create. Git owns the question of what *exists*;
// state.json stays the sidecar for what toyon adds on top.
//
// Nothing here writes: a discovered worktree is derived on every push and never persisted, which
// is what makes "toyon cannot delete a directory it did not create" structural rather than a rule
// someone has to remember.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { WorktreeInfo } from "@toyon/shared";
import { canonical } from "../agent/bounds.ts";
import { type GitWorktree, listWorktrees } from "../git/worktrees.ts";

/** what git says about a worktree toyon has no record for; the row the shell sees is built from
 * this plus counts, in `WorktreeService.rows()` */
export interface FoundWorktree {
  id: string;
  repoId: string;
  path: string;
  /** its branch, or the directory's own name when detached */
  name: string;
  branch?: string;
  locked?: boolean;
  lockReason?: string;
}

/** A discovered worktree's id: the canonical path, hashed. Derived rather than minted because
 * there is no record to keep a minted one in, and it has to be the same across pushes or an open
 * shell would lose its stream key every time the list is re-derived. The prefix is for whoever is
 * reading a log line and wondering why an id does not resolve to a worktree. */
export function discoveredId(path: string): string {
  return `disc-${createHash("sha1").update(canonical(path)).digest("hex").slice(0, 12)}`;
}

/** The paths toyon already accounts for. Spares are in here too even though `statuses()` filters
 * them out of the rail, or the pre-warmed spare would show up as somebody's stray worktree. The
 * set spans every repo, not just the one being scanned: a worktree of repo A that the user has
 * also registered as its own project is toyon's, and should not be offered for adoption twice. */
function knownPaths(known: WorktreeInfo[]): Set<string> {
  const paths = new Set<string>();
  for (const wt of known) {
    paths.add(canonical(wt.path));
    // the branch-named symlink beside a claimed spare: git reports whichever the person used
    if (wt.linkPath) paths.add(canonical(wt.linkPath));
  }
  return paths;
}

/** git's worktree list minus the ones toyon owns. Pure, so the matching rule is testable without
 * a repo: paths are canonicalised on both sides because /tmp is a symlink to /private/tmp on
 * macOS, and a worktree reached through either spelling is the same worktree. */
export function subtractKnown(repoId: string, listed: GitWorktree[], known: WorktreeInfo[]): FoundWorktree[] {
  const mine = knownPaths(known);
  const rows: FoundWorktree[] = [];
  for (const g of listed) {
    // the repository itself, not a place work happens
    if (g.bare) continue;
    // git keeps listing a worktree whose directory is gone; there is nothing to show or adopt
    if (g.prunable) continue;
    if (mine.has(canonical(g.path))) continue;
    rows.push({
      id: discoveredId(g.path),
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
export async function discoverIn(repoId: string, repoPath: string, known: WorktreeInfo[]): Promise<FoundWorktree[]> {
  return subtractKnown(repoId, await listWorktrees(repoPath), known);
}
