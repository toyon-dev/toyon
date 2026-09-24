// Watches a repo's default branch, here and on its upstream, and fires when either moves (a
// commit, a merge, a pull; a fetch, a push from elsewhere). fs events are noisy (.git/index churn
// etc.), so changes are debounced and confirmed via rev-parse before firing.

import { existsSync, type FSWatcher, watch } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR, CONFIG_FILES } from "@toyon/shared";
import { fireAndForget, log } from "../core/log.ts";
import { git } from "../git/exec.ts";

/** which copy of the default branch moved: the checkout's own, or the remote-tracking one */
export type RefMove = "local" | "upstream";

export function watchDefaultBranch(repoPath: string, branch: string, onMove: (which: RefMove) => void): () => void {
  // null until the first read: the initial position is fetched asynchronously, and a change
  // before it lands is simply the new baseline. The upstream reads as "" while there is none, so
  // its first fetch appearing is a move (the base may follow it) and never a baseline.
  const last: Record<RefMove, string | null> = { local: null, upstream: null };
  const read = async (): Promise<Record<RefMove, string>> => {
    const [local, up] = await Promise.all([
      git(repoPath, "rev-parse", branch),
      git(repoPath, "rev-parse", "--verify", "--quiet", `${branch}@{upstream}`),
    ]);
    return { local: local.out, upstream: up.ok ? up.out : "" };
  };
  fireAndForget(
    repoPath,
    read().then((now) => {
      // a failed local read leaves last null: the first successful check then sets the baseline
      // without firing (an empty string would make every later commit look like a move)
      if (now.local) last.local ??= now.local;
      last.upstream ??= now.upstream;
    }),
    "ref watcher baseline",
  );
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = async () => {
    timer = null;
    const now = await read();
    if (!now.local) return;
    // upstream first: the base may move with it, and the local event's readers count against
    // the base
    if (last.upstream !== null && now.upstream !== last.upstream) onMove("upstream");
    if (last.local !== null && now.local !== last.local) onMove("local");
    last.local = now.local;
    last.upstream = now.upstream;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fireAndForget(repoPath, check(), "ref watcher check"), 1000);
  };

  let stopped = false;
  const watchers: FSWatcher[] = [];
  const tryWatch = (p: string, listener: Parameters<typeof watch>[1] = schedule): FSWatcher | null => {
    try {
      const w = watch(p, listener);
      w.on("error", (e) => log.warn(repoPath, `ref watcher error on ${p}`, e));
      watchers.push(w);
      return w;
    } catch (e) {
      // a bare repo or a missing refs dir: the other path usually exists
      log.debug(repoPath, `not watching ${p}`, e);
      return null;
    }
  };
  // The refs live in the common git dir, which is not `<repo>/.git` when the repo is itself a
  // linked worktree (that `.git` is a file). Loose refs sit in refs/heads/<branch> and
  // refs/remotes/<remote>/<branch>; packed-refs and HEAD in the dir itself.
  fireAndForget(
    repoPath,
    (async () => {
      const [common, remote] = await Promise.all([
        git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"),
        git(repoPath, "config", "--get", `branch.${branch}.remote`),
      ]);
      if (stopped) return;
      const gitDir = common.ok && common.out ? common.out : join(repoPath, ".git");
      tryWatch(gitDir);
      tryWatch(join(gitDir, "refs", "heads"));
      if (!remote.ok || !remote.out) return;
      // refs/remotes/<remote> is made by the first fetch, so a fresh remote has no directory to
      // watch yet: the two levels above arm it when it appears, the way the settings watcher
      // arms .toyon/, and re-arm it when git recreates it
      const remotes = join(gitDir, "refs", "remotes");
      const mine = join(remotes, remote.out);
      let inner: FSWatcher | null = null;
      let mid: FSWatcher | null = null;
      const armInner = () => {
        inner?.close();
        inner = existsSync(mine) ? tryWatch(mine) : null;
      };
      const armMid = () => {
        mid?.close();
        mid = existsSync(remotes)
          ? tryWatch(remotes, (_event, filename) => {
              if (!filename || filename === remote.out) armInner();
              schedule();
            })
          : null;
        armInner();
      };
      tryWatch(join(gitDir, "refs"), (_event, filename) => {
        if (!filename || filename === "remotes") armMid();
        schedule();
      });
      armMid();
    })(),
    "ref watcher setup",
  );

  return () => {
    stopped = true;
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

/** Fires (debounced) when any of a repo's settings files is written, created, replaced or removed:
 * the pair at the root and the pair in .toyon/. Watches directories, not files: editors save by
 * rename, which would orphan a watcher on the inode. The folder may not exist yet, so the root
 * watcher arms the inner one whenever .toyon itself changes, the way watchWorktreeDir does. */
export function watchConfigFile(repoPath: string, onChange: () => void): () => void {
  const atRoot = new Set<string>([CONFIG_FILES.root.shared, CONFIG_FILES.root.local, CONFIG_DIR]);
  const inDir = new Set([CONFIG_FILES.folder.shared, CONFIG_FILES.folder.local].map((rel) => basename(rel)));
  const dir = join(repoPath, CONFIG_DIR);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let outer: FSWatcher | null = null;
  let inner: FSWatcher | null = null;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 300);
  };
  const armInner = () => {
    inner?.close();
    inner = null;
    if (!existsSync(dir)) return;
    try {
      inner = watch(dir, (_event, filename) => {
        if (filename && !inDir.has(filename)) return;
        schedule();
      });
      inner.on("error", (e) => log.warn(repoPath, "settings watcher error", e));
    } catch (e) {
      log.debug(repoPath, `not watching ${dir}`, e);
    }
  };
  try {
    outer = watch(repoPath, (_event, filename) => {
      if (filename && !atRoot.has(filename)) return;
      if (!filename || filename === CONFIG_DIR) armInner();
      schedule();
    });
    outer.on("error", (e) => log.warn(repoPath, "settings watcher error", e));
  } catch (e) {
    log.warn(repoPath, "not watching the settings files", e);
  }
  armInner();
  return () => {
    outer?.close();
    inner?.close();
    if (timer) clearTimeout(timer);
  };
}
