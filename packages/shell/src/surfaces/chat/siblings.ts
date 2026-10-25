import type { OwnedWorktree } from "@toyon/shared";
import { sentAt } from "@toyon/shared";
import { type DotState, dotClass, stateLabel } from "../util.ts";

/** a worktree of the project a message can name, in the rail's order */
export interface Sibling {
  id: string;
  title: string;
  branch: string;
  /** its directory's name, which is what a terminal or a transcript path shows of it */
  dir: string;
  /** the rail's dot for it, so the row says what the worktree is doing as the rail does */
  dot: DotState;
  /** the dot in words, as the rail's tip says them */
  state: string;
  /** when it was last sent to, which the rail is ordered by */
  at: number;
}

/** The project's other worktrees with a chat to point at, in the rail's order (the rows the rail
 * shows, which are already sorted so): the rows Toyon runs, less main and the spare (neither has
 * a chat of its own) and the row the message is written in. Nothing for a message with no
 * project: a found worktree, a draft, an archive. */
export function siblingWorktrees(
  rows: readonly OwnedWorktree[],
  repoId: string | undefined,
  self: string | null | undefined,
): Sibling[] {
  if (!repoId) return [];
  const out: Sibling[] = [];
  for (const r of rows) {
    const w = r.worktree;
    if (w.repoId !== repoId || w.id === self || w.kind !== "worktree") continue;
    out.push({
      id: w.id,
      title: w.title,
      branch: w.branch,
      dir: w.path.slice(w.path.lastIndexOf("/") + 1),
      dot: dotClass(r),
      state: stateLabel(r),
      at: sentAt(w),
    });
  }
  return out;
}

/** The reference a paste of a worktree's name stands for, `@branch` with the space that lets the
 * sentence go on, or null for any other text. Only a name pasted whole and alone counts: the
 * branch, or the directory `wt-xxxx` that a terminal, a path and the agent's prose spell the
 * worktree by. The sentence's own `@branch` is already the reference and pastes as typed; a name
 * inside other words is those words, and pastes as they are. The names are read in the order
 * given, so a row open now wins over the archive's record of the same branch. */
export function pastedWorktree(text: string, names: readonly Pick<Sibling, "branch" | "dir">[]): string | null {
  const name = text.trim();
  if (!name || /\s/.test(name)) return null;
  const hit = names.find((w) => w.branch === name || w.dir === name);
  return hit ? `@${hit.branch} ` : null;
}

/** The reference text put into the field whole without a paste stands for, read as pastedWorktree
 * reads a paste. A phone keyboard's clipboard key commits the copy the way it commits a word, so
 * the browser sees an insert and no paste. A tapped word suggestion is the same kind of insert, so
 * only a name no keyboard would offer as a word counts: one with a slash or a dash in it, which
 * every branch and every `wt-xxxx` directory has. */
export function insertedWorktree(text: string, names: readonly Pick<Sibling, "branch" | "dir">[]): string | null {
  return /[/-]/.test(text) ? pastedWorktree(text, names) : null;
}

/** letters and digits alone, so a title typed as its slug, with dashes, or run together all read
 * as the title; the words of a title typed with their spaces read the same way */
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** an id or a directory is hex, so a digit or a letter typed on its own would land in nearly every
 * one: those are read from their start, and only once this many characters say which */
const HEX_FROM = 3;

/** whether a `@` query names the worktree: by its title or its branch, anywhere in them, or by its
 * id (which names its transcript) or its directory from their start, each read without
 * punctuation or spaces. A query with no letter or digit in it (`@-`, `@?`) names nothing; only
 * the blank query is the bare `@` that offers every row. A query ending in a space is the title's
 * next word about to be typed, which only a name with more left can take: `@stop ` still names
 * "Stop ignored", but `@toyon/stop-ignored ` names it whole, so the space after it is the sentence
 * going on and the menu has nothing left to offer. */
export function matchesSibling(query: string, w: Pick<Sibling, "title" | "branch" | "id" | "dir">): boolean {
  const q = plain(query);
  if (!q) return !query.trim();
  const more = /\s$/.test(query);
  const whole = (n: string) => more && n.endsWith(q);
  if ([w.title, w.branch].some((name) => plain(name).includes(q) && !whole(plain(name)))) return true;
  if (q.length < HEX_FROM) return false;
  return [w.id, w.dir].some((name) => plain(name).startsWith(q) && !whole(plain(name)));
}
