// The worktree a message the agent sent with its own tool went to. Claude Code addresses another
// session by a name built on the directory that session runs in, and for a session in a worktree
// that directory is all the name says: `wt-60d5-d0`. A person knows the worktree by its title, so
// the row names it as every other row names a worktree. Claude Code's name carries no project, so
// the directory is looked up in every project Toyon holds.

import { isOwned } from "@toyon/shared";
import { archivedById, repoById, rowById, type State } from "../../state/store.ts";
import { peerDir } from "./toolCall.ts";

export interface PeerWorktree {
  id: string;
  title: string;
  /** the project it is in, when that is not the one the message left from */
  project?: string;
}

type Hit = { id: string; title: string; repoId: string };

const dirOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The worktree whose directory the address is built on, or null: the whole directory name has to
 * be a worktree's, so an address that only starts like one names nothing. Main and the spare are
 * left as written: a session in a main checkout is as likely one started in a terminal, and
 * neither is a row a chip opens. The sender's own project is read first, its rows before its
 * archive, since a row brought back from the archive is a row. A directory name is unique only
 * within a project, so one that two other projects both have says nothing about which was meant. */
export function peerWorktree(
  s: Pick<State, "rows" | "archived" | "repos">,
  to: string,
  from: string | null | undefined,
): PeerWorktree | null {
  const dir = peerDir(to);
  if (!dir) return null;
  const live: Hit[] = [];
  for (const r of s.rows) {
    if (!isOwned(r) || r.worktree.kind !== "worktree" || dirOf(r.worktree.path) !== dir) continue;
    live.push({ id: r.id, title: r.worktree.title, repoId: r.repoId });
  }
  const archived: Hit[] = [];
  for (const items of Object.values(s.archived)) {
    for (const a of items) if (dirOf(a.path) === dir) archived.push({ id: a.id, title: a.title, repoId: a.repoId });
  }
  const here = (from && (rowById(s, from)?.repoId ?? archivedById(s, from)?.repoId)) || undefined;
  const hit =
    live.find((h) => h.repoId === here) ??
    archived.find((h) => h.repoId === here) ??
    (live.length === 1 ? live[0] : live.length === 0 && archived.length === 1 ? archived[0] : undefined);
  if (!hit) return null;
  const project = hit.repoId === here ? undefined : repoById(s, hit.repoId)?.name;
  return { id: hit.id, title: hit.title, ...(project ? { project } : {}) };
}

/** The same as one string, "" for none, so a selector over the store settles: the row holds this
 * across every status tick, and a fresh object each read would never be the one before it. */
export function peerKey(
  s: Pick<State, "rows" | "archived" | "repos">,
  to: string,
  from: string | null | undefined,
): string {
  const hit = peerWorktree(s, to, from);
  return hit ? JSON.stringify(hit) : "";
}
