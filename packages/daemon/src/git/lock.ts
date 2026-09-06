// Per-repo mutex for daemon-initiated mutations of shared git state
// (branch create/delete, worktree add/remove, spare refresh). Agent commits in
// their own worktrees need no coordination (separate indexes).
const locks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    repoPath,
    next.catch(() => {}),
  );
  return next;
}
