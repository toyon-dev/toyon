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

/** How far main trails origin as of the last fetch: what a new worktree would start without. The
 * trunk follows origin on its own when it is clean, so a count that stands says why it stood:
 * uncommitted files on main hold it where it is (the come-along check is the way to clear them
 * from here), or its history diverged, which is a terminal's job. */
export function originNote(
  defaultBranch: string,
  trunk: { behind?: number; dirty: number; stale?: "dirty" | "diverged" | "no-upstream" },
): string | null {
  const n = trunk.behind ?? 0;
  if (n === 0) return null;
  if (trunk.stale === "diverged") return `${defaultBranch} has diverged from origin`;
  if (trunk.stale === "dirty" && trunk.dirty > 0) {
    const files = `~${trunk.dirty} uncommitted`;
    return `${n} behind origin; ${files} on ${defaultBranch} ${trunk.dirty === 1 ? "keeps" : "keep"} it where it is`;
  }
  return `${n} behind origin`;
}

/** whether the pull is worth offering beside the note: not on a history a fast-forward cannot take */
export function canPull(trunk: { stale?: "dirty" | "diverged" | "no-upstream" }): boolean {
  return trunk.stale !== "diverged";
}
