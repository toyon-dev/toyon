// What a prompt says about the worktree it is talking to, or the main it is about to branch from:
// a worktree that has fallen behind main gets told so where the next message is typed, and a main
// nobody has pulled today hands a new worktree stale code.

/** how far a worktree trails its default branch; null when it does not. Terse on purpose: it
 * sits under the composer on every message, so "4 behind main" and no more. */
export function behindNote(defaultBranch: string, behind: number | undefined): string | null {
  const n = behind ?? 0;
  if (n === 0) return null;
  return `${n} behind ${defaultBranch}`;
}

/** how far main trails origin as of the last fetch: what a new worktree would start without */
export function originNote(behind: number | undefined): string | null {
  const n = behind ?? 0;
  if (n === 0) return null;
  return `${n} behind origin`;
}
