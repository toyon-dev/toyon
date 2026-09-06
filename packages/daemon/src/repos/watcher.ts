// Watches a repo's default branch ref and fires when it moves (commit, merge,
// pull). fs events are noisy (.git/index churn etc.), so changes are debounced
// and confirmed via rev-parse before firing.

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { git } from "../git/exec.ts";

export function watchDefaultBranch(repoPath: string, branch: string, onMove: () => void): () => void {
  // null until the first read: the initial position is fetched asynchronously, and a change
  // before it lands is simply the new baseline
  let last: string | null = null;
  void git(repoPath, "rev-parse", branch).then((r) => {
    last ??= r.out;
  });
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
    timer = setTimeout(() => void check(), 1000);
  };

  const watchers: FSWatcher[] = [];
  const tryWatch = (p: string) => {
    try {
      watchers.push(watch(p, schedule));
    } catch {}
  };
  // loose refs live in .git/refs/heads/<branch>; packed-refs + HEAD in .git/
  tryWatch(join(repoPath, ".git"));
  tryWatch(join(repoPath, ".git", "refs", "heads"));

  return () => {
    for (const w of watchers) w.close();
    if (timer) clearTimeout(timer);
  };
}
