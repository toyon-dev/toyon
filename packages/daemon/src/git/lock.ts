// Keyed mutexes. A repo's key serialises daemon-initiated mutations of shared git state (branch
// create/delete, worktree add/remove, spare refresh); agent commits in their own worktrees need no
// coordination (separate indexes). A file's key serialises the editor's version check with its
// write, and both with a discard of the same file.
const locks = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  // a file key is one per file ever saved, so a settled chain lets go of its entry
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

export function withRepoLock<T>(repoPath: string, fn: () => Promise<T> | T): Promise<T> {
  return withLock(repoPath, fn);
}

/** One fetch at a time per repo. Every worktree shares the main checkout's remote-tracking refs,
 * and two fetches that both find origin's main moved race to write it: the loser exits non-zero
 * with "cannot lock ref" though the ref is where it should be. Its own key, not the repo's: a
 * fetch holds the network for seconds, and nothing that mutates the checkout waits on that. */
export function withFetchLock<T>(repoPath: string, fn: () => Promise<T> | T): Promise<T> {
  return withLock(`fetch:${repoPath}`, fn);
}

/** the key a file's editor writes and discards share; prefixed so it never meets a repo's path */
export const fileLockKey = (absPath: string) => `file:${absPath}`;
