// Watches a repo's default branch ref and fires when it moves (commit, merge,
// pull). fs events are noisy (.git/index churn etc.), so changes are debounced
// and confirmed via rev-parse before firing.

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { git } from "../git/exec.ts";

export function watchDefaultBranch(repoPath: string, branch: string, onMove: () => void): () => void {
  let last = git(repoPath, "rev-parse", branch).out;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = () => {
    timer = null;
    const now = git(repoPath, "rev-parse", branch).out;
    if (now && now !== last) {
      last = now;
      onMove();
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, 1000);
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
