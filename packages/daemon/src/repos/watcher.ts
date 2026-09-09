// Watches a repo's default branch ref and fires when it moves (commit, merge,
// pull). fs events are noisy (.git/index churn etc.), so changes are debounced
// and confirmed via rev-parse before firing.

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { fireAndForget, log } from "../core/log.ts";
import { git } from "../git/exec.ts";

export function watchDefaultBranch(repoPath: string, branch: string, onMove: () => void): () => void {
  // null until the first read: the initial position is fetched asynchronously, and a change
  // before it lands is simply the new baseline
  let last: string | null = null;
  fireAndForget(
    repoPath,
    git(repoPath, "rev-parse", branch).then((r) => {
      // a failed read leaves last null: the first successful check then sets the baseline
      // without firing (an empty string would make every later commit look like a move)
      if (r.out) last ??= r.out;
    }),
    "ref watcher baseline",
  );
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = async () => {
    timer = null;
    const now = (await git(repoPath, "rev-parse", branch)).out;
    if (!now) return;
    if (last !== null && now !== last) onMove();
    last = now;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fireAndForget(repoPath, check(), "ref watcher check"), 1000);
  };

  const watchers: FSWatcher[] = [];
  const tryWatch = (p: string) => {
    try {
      watchers.push(watch(p, schedule));
    } catch (e) {
      // a bare repo or a missing refs dir: the other path usually exists
      log.debug(repoPath, `not watching ${p}`, e);
    }
  };
  // loose refs live in .git/refs/heads/<branch>; packed-refs + HEAD in .git/
  tryWatch(join(repoPath, ".git"));
  tryWatch(join(repoPath, ".git", "refs", "heads"));

  return () => {
    for (const w of watchers) w.close();
    if (timer) clearTimeout(timer);
  };
}

/** Fires (debounced) when the set of linked worktrees changes: `git worktree add` and
 * `git worktree remove` both write under `<common git dir>/worktrees`.
 *
 * Two reasons this cannot ride along on `watchDefaultBranch`. Its confirm step is `rev-parse
 * <default branch>`, and adding a worktree does not move that ref, so it would never fire. And a
 * non-recursive `fs.watch` reports a directory's own entries changing: watching `.git` sees
 * `worktrees/` appear for a repo's very first linked worktree and nothing afterwards, because
 * every later add and remove happens one level down.
 *
 * The common git dir is asked for rather than built, because `<repo>/.git` is a *file* when the
 * repo is itself a linked worktree, and `<that>/worktrees` would never exist. */
export function watchWorktreeDir(repoPath: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let outer: FSWatcher | null = null;
  let inner: FSWatcher | null = null;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    // no rev-parse confirm: "something under worktrees/ changed" is already the signal, and the
    // reader re-derives from `git worktree list` anyway
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 300);
  };

  const arm = (commonDir: string) => {
    const dir = join(commonDir, "worktrees");
    // re-armed on every outer event: git creates this directory with the first linked worktree and
    // may drop it with the last, and a watcher on the old inode would go quiet
    const armInner = () => {
      inner?.close();
      inner = null;
      try {
        inner = watch(dir, schedule);
        inner.on("error", (e) => log.warn(repoPath, "worktree watcher error", e));
      } catch (e) {
        // no linked worktrees yet: the outer watcher arms this one when the directory appears
        log.debug(repoPath, `not watching ${dir}`, e);
      }
    };
    try {
      outer = watch(commonDir, (_event, filename) => {
        if (filename && filename !== "worktrees") return;
        armInner();
        schedule();
      });
      outer.on("error", (e) => log.warn(repoPath, "worktree watcher error", e));
    } catch (e) {
      log.warn(repoPath, "not watching for new worktrees", e);
    }
    armInner();
  };

  fireAndForget(
    repoPath,
    git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir").then((r) => {
      // stop() may have run while the rev-parse was in flight
      if (stopped) return;
      if (r.ok && r.out) arm(r.out);
      else log.debug(repoPath, "no common git dir: not watching for new worktrees");
    }),
    "worktree watcher setup",
  );

  return () => {
    stopped = true;
    outer?.close();
    inner?.close();
    if (timer) clearTimeout(timer);
  };
}

/** fires (debounced) when `<repo>/toyon.json` is written, created or replaced. Watches the
 * directory, not the file: editors save by rename, which would orphan a watcher on the inode. */
export function watchConfigFile(repoPath: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(repoPath, (_event, filename) => {
      if (filename && filename !== "toyon.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, 300);
    });
    watcher.on("error", (e) => log.warn(repoPath, "toyon.json watcher error", e));
  } catch (e) {
    log.warn(repoPath, "not watching toyon.json", e);
  }
  return () => {
    watcher?.close();
    if (timer) clearTimeout(timer);
  };
}
