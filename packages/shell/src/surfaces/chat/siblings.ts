import type { WorktreeStatus } from "@toyon/shared";

/** a worktree of the project a message can name, in the rail's order */
export interface Sibling {
  id: string;
  title: string;
  branch: string;
  /** its directory's name, which is what a terminal or a transcript path shows of it */
  dir: string;
}

/** The project's other worktrees with a chat to point at, in the rail's order: the rows Toyon
 * runs, less main and the spare (neither has a chat of its own) and the row the message is
 * written in. Nothing for a message with no project: a found worktree, a draft, an archive. */
export function siblingWorktrees(
  rows: readonly WorktreeStatus[],
  repoId: string | undefined,
  self: string | null | undefined,
): Sibling[] {
  if (!repoId) return [];
  const out: Sibling[] = [];
  for (const r of rows) {
    const w = r.worktree;
    if (!w || w.repoId !== repoId || w.id === self || w.kind !== "worktree") continue;
    out.push({ id: w.id, title: w.title, branch: w.branch, dir: w.path.slice(w.path.lastIndexOf("/") + 1) });
  }
  return out;
}

/** letters and digits alone, so a title typed as its slug, with dashes, or run together all read
 * as the title: a mention ends at a space, so the words of a title cannot be typed with them */
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** whether a `@` query names the worktree: by its title, its branch, its id (which names its
 * transcript) or its directory, each read without punctuation or spaces */
export function matchesSibling(query: string, w: Sibling): boolean {
  const q = plain(query);
  if (!q) return true;
  return [w.title, w.branch, w.id, w.dir].some((name) => plain(name).includes(q));
}
