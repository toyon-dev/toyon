// What a worktree's last turn changed. A worktree's uncommitted work piles up over many turns, and
// the changes list shows the pile; the tree as it stood when a message was sent is the only thing
// that can say which part of it the turn after that message wrote. Each turn keeps that tree as a
// commit under a ref, two deep: the newest, and the one before it for a turn that has written
// nothing yet (or never does: a question answered), so the section still shows the last turn that
// changed something.

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitFileStatus } from "@toyon/shared";
import { GIT, git, run } from "./exec.ts";
import { filesBetween } from "./status.ts";

/** outside refs/heads, so no branch list, ref picker or push ever shows them */
const turnRef = (worktreeId: string, which: "at" | "before") => `refs/toyon/turns/${worktreeId}/${which}`;

const SNAPSHOT_SUBJECT = "toyon: tree at a send";

export interface TurnChanges {
  /** the commit holding the tree the turn started from: the before side of each file's diff */
  base: string;
  files: GitFileStatus[];
}

/** one tree read at a time per worktree: two `add`s on one index race for its lock, and the loser
 * would report a tree that is not there */
const queue = new Map<string, Promise<unknown>>();
function inTurn<T>(wtPath: string, job: () => Promise<T>): Promise<T> {
  const next = (queue.get(wtPath) ?? Promise.resolve()).then(job, job);
  queue.set(
    wtPath,
    next.catch(() => {}),
  );
  return next;
}

/** What toyon's index was last made to match: the HEAD it was read under, and the paths that
 * differed from that HEAD. Held in memory, so a daemon that restarted starts from a full pass. */
interface Synced {
  index: string;
  head: string;
  dirty: Set<string>;
}
const synced = new Map<string, Synced>();

/** past this many paths a full pass is the cheaper ask, and the argument list stays far from its limit */
const MAX_PATHS = 400;

/** The working tree as a tree object: tracked and untracked files, ignored ones not. Staged into
 * an index of toyon's own beside the worktree's, so the person's staging area is never touched.
 *
 * The index is kept between reads and brought up to date rather than rebuilt, because the read
 * rides every status push and a full pass stats the whole tree: a second `git status` on a repo
 * where one is already slow. Given `dirty`, the paths the status just listed, only those and the
 * ones that were dirty at the last read are staged again. That is every path that can have moved:
 * under one HEAD a file is either clean, and so what the index already holds for it, or among
 * them. A HEAD that moved (a checkout, a rebase) changes clean files too, and a staged rename
 * names only its new path, so both take the full pass, as does a read with no list. */
async function treeNow(wtPath: string, head: string, dirty?: GitFileStatus[]): Promise<string | null> {
  let was = synced.get(wtPath);
  let index = was?.index;
  if (!index) {
    const dir = await git(wtPath, "rev-parse", "--absolute-git-dir");
    if (!dir.ok || !dir.out) return null;
    index = join(dir.out, "toyon-turn-index");
  }
  const env = { GIT_INDEX_FILE: index };
  const writeTree = async () => {
    const tree = await run(GIT, ["write-tree"], wtPath, env);
    return tree.ok && tree.out ? tree.out : null;
  };
  if (!existsSync(index)) was = undefined;
  const paths = dirty && !dirty.some((f) => /[RC]/.test(f.xy)) ? dirty.map((f) => f.path) : null;
  if (was && paths && was.head === head) {
    const again = [...new Set([...was.dirty, ...paths])];
    if (again.length <= MAX_PATHS) {
      const added =
        again.length === 0 || (await run(GIT, ["--literal-pathspecs", "add", "-A", "--", ...again], wtPath, env)).ok;
      const tree = added ? await writeTree() : null;
      if (tree) {
        synced.set(wtPath, { index, head, dirty: new Set(paths) });
        return tree;
      }
    }
  }
  synced.delete(wtPath);
  if (!existsSync(index)) {
    const own = join(index, "..", "index");
    // the worktree's own index brings its stat cache along; without one, HEAD's tree is the start
    if (existsSync(own)) copyFileSync(own, index);
    else if (!(await run(GIT, ["read-tree", "HEAD"], wtPath, env)).ok) return null;
  }
  const full = async () => ((await run(GIT, ["add", "-A"], wtPath, env)).ok ? writeTree() : null);
  let tree = await full();
  if (!tree) {
    // an index git will not read (copied mid-write, or cut short by a kill) would refuse every read
    // from here on: start it again from HEAD, at the cost of one full hash of the tree
    rmSync(index, { force: true });
    if (!(await run(GIT, ["read-tree", "HEAD"], wtPath, env)).ok) return null;
    tree = await full();
    if (!tree) return null;
  }
  // what differs from HEAD, read between two trees: no second walk of the files
  const differs = await git(wtPath, "diff", "--name-only", "--no-renames", "-z", head, tree);
  if (differs.ok) synced.set(wtPath, { index, head, dirty: new Set(differs.out.split("\0").filter(Boolean)) });
  return tree;
}

/** the commits and trees a snapshot ref names, or null when the ref names nothing */
async function snapshotAt(
  wtPath: string,
  ref: string,
): Promise<{ commit: string; tree: string; parent: string } | null> {
  const r = await git(wtPath, "rev-parse", "--quiet", `${ref}^{commit}`, `${ref}^{tree}`, `${ref}^`);
  const [commit, tree, parent] = r.ok ? r.out.split("\n") : [];
  return commit && tree && parent ? { commit, tree, parent } : null;
}

/** A turn is starting: keep the tree it starts from. A send over a tree the last send already
 * kept moves nothing, so a turn that wrote nothing leaves the one before it in place. */
export function markTurn(wtPath: string, worktreeId: string): Promise<void> {
  return inTurn(wtPath, async () => {
    const head = await git(wtPath, "rev-parse", "--verify", "HEAD");
    if (!head.ok) return;
    // the full pass, once a turn: whatever a partial read could have missed is put right here
    const tree = await treeNow(wtPath, head.out);
    if (!tree) return;
    const at = await snapshotAt(wtPath, turnRef(worktreeId, "at"));
    if (at?.tree === tree && at.parent === head.out) return;
    // toyon's own identity: the commit is its bookkeeping and is never pushed, and a repo with no
    // user configured would otherwise refuse to make it
    const commit = await git(
      wtPath,
      "-c",
      "user.name=toyon",
      "-c",
      "user.email=toyon@localhost",
      "commit-tree",
      tree,
      "-p",
      head.out,
      "-m",
      SNAPSHOT_SUBJECT,
    );
    if (!commit.ok) return;
    // the same tree under a new HEAD (a commit since the last send) is the same starting point,
    // restated so it is still read against the branch it now sits on
    if (at && at.tree !== tree) await git(wtPath, "update-ref", turnRef(worktreeId, "before"), at.commit);
    await git(wtPath, "update-ref", turnRef(worktreeId, "at"), commit.out);
  });
}

/** What the last turn that wrote anything changed, read against the tree as it stands. Null when
 * there is nothing to tell apart: no send kept, the kept tree is HEAD's (the uncommitted list is
 * already exactly this), nothing changed since, or the branch took the default branch in after the
 * send, since then the difference holds everyone else's work too. `own` is false for the main
 * checkout, whose HEAD is the default branch: there any move of HEAD ends it. `dirty` is the
 * status read this rides with: the paths it lists are all that need looking at again. */
export function turnChanges(
  wtPath: string,
  worktreeId: string,
  defaultBr: string,
  own: boolean,
  dirty?: GitFileStatus[],
): Promise<TurnChanges | null> {
  return inTurn(wtPath, async () => {
    const at = await snapshotAt(wtPath, turnRef(worktreeId, "at"));
    if (!at) return null;
    const head = await git(wtPath, "rev-parse", "HEAD", "HEAD^{tree}");
    const [headCommit, headTree] = head.ok ? head.out.split("\n") : [];
    if (!headCommit) return null;
    const tree = await treeNow(wtPath, headCommit, dirty);
    if (!tree) return null;
    // the running turn once it has written; until then, and after a turn that never did, the one before
    const from = at.tree !== tree ? at : await snapshotAt(wtPath, turnRef(worktreeId, "before"));
    if (!from || from.tree === tree || from.tree === headTree) return null;
    if (from.parent !== headCommit) {
      if (!own) return null;
      const [then, now] = await Promise.all([
        git(wtPath, "merge-base", from.parent, defaultBr),
        git(wtPath, "merge-base", headCommit, defaultBr),
      ]);
      if (!then.ok || !now.ok || then.out !== now.out) return null;
    }
    const files = await filesBetween(wtPath, from.commit, tree);
    return files.length > 0 ? { base: from.commit, files } : null;
  });
}

/** Drop the trees a worktree's sends kept. Best effort: a ref left behind only keeps objects alive. */
export async function dropTurnRefs(repoPath: string, worktreeId: string): Promise<void> {
  for (const which of ["at", "before"] as const) await git(repoPath, "update-ref", "-d", turnRef(worktreeId, which));
}
