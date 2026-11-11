// A worktree's files, made from two things the daemon reads apart: the paths in git's index and
// the status. The index is one file, so listing it costs the same whatever the checkout holds;
// what is on disk differs from it by the untracked files and the deleted ones, and the status,
// which is read after every tool call anyway, names both. Asking git what is on disk instead
// walks every folder and stats every tracked file, for the same answer.

import type { GitFileStatus } from "./model.ts";

/** both sides of a merge touched the path: the index holds it, in stages */
const unmerged = (xy: string) => xy.includes("U") || xy === "AA" || xy === "DD";

/**
 * Whether the path a status entry names is a file on disk, or null where the status does not
 * say. The worktree's column says a tracked file is gone; a deletion that is staged has nothing
 * left to say there, and its file is gone as well, since one still on disk would be listed a
 * second time as untracked and the daemon folds that pair into one modified entry. An unmerged
 * path is the one the status cannot answer for: a merge leaves the file of a path one side
 * deleted, a stash applied over a deletion does not, and both read the same. The daemon looks
 * on disk for those when it lists the index, so the list is left as it stands.
 */
export function onDisk(xy: string): boolean | null {
  if (unmerged(xy)) return null;
  return xy[1] !== "D" && xy !== "D ";
}

/**
 * What decides the index's paths: the commit checked out, and what is staged over it that adds,
 * removes or renames a path or leaves one unmerged. A list of the index read under one key is
 * the index for as long as the key stands, so an edit, a new file and a deleted one ask for
 * nothing; a commit, a pull and a `git add` of a new file read it again.
 */
export function indexKey(head: string | undefined, status: readonly GitFileStatus[]): string {
  const staged: string[] = [];
  for (const s of status) {
    if (s.xy === "??") continue;
    if (unmerged(s.xy)) staged.push(`${s.xy}${s.path}`);
    else if ("ADRC".includes(s.xy.charAt(0))) staged.push(`${s.xy.charAt(0)}${s.path}`);
  }
  return [head ?? "", ...staged.sort()].join("\0");
}

/** What the status says of the disk beside the index: the untracked files and the ones gone.
 * What git ignores is walked again when this moves, since a new file can be a new ignored one. */
export function diskKey(status: readonly GitFileStatus[]): string {
  const moved: string[] = [];
  for (const s of status) {
    if (s.xy === "??") moved.push(`+${s.path}`);
    else if (onDisk(s.xy) === false) moved.push(`-${s.path}`);
  }
  return moved.sort().join("\0");
}

/** how the files on disk differ from the index's paths; `key` is the same for the same difference */
export interface ListingDelta {
  key: string;
  added: string[];
  gone: ReadonlySet<string>;
}

// one set per list of the index: a status arrives after every tool call, and each is read
// against the same hundred thousand paths
const indexed = new WeakMap<readonly string[], ReadonlySet<string>>();

/** Read a status against the index's paths. Every entry is asked, not only the untracked: a file
 * the index dropped and the disk kept arrives as modified, and it is a file the list may lack. */
export function listingDelta(tracked: readonly string[], status: readonly GitFileStatus[]): ListingDelta {
  let has = indexed.get(tracked);
  if (!has) {
    has = new Set(tracked);
    indexed.set(tracked, has);
  }
  const added = new Set<string>();
  const gone = new Set<string>();
  for (const s of status) {
    const there = onDisk(s.xy);
    if (there === null) continue;
    if (!there) {
      if (has.has(s.path)) gone.add(s.path);
    } else if (!has.has(s.path)) added.add(s.path);
  }
  const key = [...[...added].map((p) => `+${p}`), ...[...gone].map((p) => `-${p}`)].sort().join("\0");
  return { key, added: [...added], gone };
}

/** the files on disk: the index's paths less the ones gone, then the ones it lacks. The list
 * handed in is handed back when the disk and the index agree. */
export function listedFiles(tracked: string[], delta: ListingDelta): string[] {
  if (delta.added.length === 0 && delta.gone.size === 0) return tracked;
  const kept = delta.gone.size > 0 ? tracked.filter((p) => !delta.gone.has(p)) : tracked;
  return kept.concat(delta.added);
}
