// Which worktrees git knows about. This is the source of truth for what *exists*; state.json stays
// the sidecar for what toyon adds on top (proxy port, agent session, title, variant group).
//
// Never enumerate `.git/worktrees/` instead: entries linger there for worktrees whose directory is
// long gone, and only git filters them out (it reports those as prunable, if at all).
// The parser is pure; the function around it shells out through git/exec.

import { git } from "./exec.ts";

export interface GitWorktree {
  /** absolute path to the worktree's directory */
  path: string;
  /** the commit HEAD points at; absent on a bare entry */
  head?: string;
  /** branch name, `refs/heads/` stripped; absent when detached or bare */
  branch?: string;
  detached: boolean;
  bare: boolean;
  /** another tool has claimed this worktree (`git worktree lock`) */
  locked: boolean;
  /** git's reason for the lock, when it gave one. Claude Code writes its session name and pid here. */
  lockReason?: string;
  /** git considers the directory gone or unusable; the value is its reason */
  prunable?: string;
}

/** `git worktree list --porcelain` → one entry per worktree.
 *
 * The format is a label per line, a blank line between records, and boolean attributes present as a
 * bare label. Records are delimited by the `worktree` label rather than by the blank line, which
 * makes the parse total: a trailing newline, a missing blank line, or an attribute a newer git
 * grows all fall out as "ignored" instead of a wrong entry. */
export function parseWorktreeList(out: string): GitWorktree[] {
  const entries: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  for (const line of out.split("\n")) {
    const sp = line.indexOf(" ");
    const label = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1);
    switch (label) {
      case "worktree":
        if (cur) entries.push(cur);
        cur = { path: unquote(value), detached: false, bare: false, locked: false };
        break;
      case "HEAD":
        if (cur) cur.head = value;
        break;
      case "branch":
        if (cur) cur.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        if (cur) cur.detached = true;
        break;
      case "bare":
        if (cur) cur.bare = true;
        break;
      case "locked":
        // `locked` alone is a lock with no reason given, which is still a lock
        if (cur) {
          cur.locked = true;
          if (value) cur.lockReason = unquote(value);
        }
        break;
      case "prunable":
        if (cur) cur.prunable = value || "prunable";
        break;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** git quotes a path or a lock reason only when it holds unusual characters (core.quotePath), and
 * the escaping it uses is C-style, which JSON's happens to cover for everything git emits here. */
function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  try {
    return JSON.parse(s);
  } catch {
    // a quoting scheme JSON cannot read is still better shown raw than dropped
    return s;
  }
}

/** Every worktree git knows about for this repo, the main checkout included. Any worktree of the
 * repo reports the same list, so the caller may pass whichever path it has. */
export async function listWorktrees(repoPath: string): Promise<GitWorktree[]> {
  const r = await git(repoPath, "worktree", "list", "--porcelain");
  if (!r.ok || !r.out) return [];
  return parseWorktreeList(r.out);
}
