// What a prompt says about the worktree it is about to branch from, or about the one it is
// talking to. A new worktree starts from its base's last commit, so a half-done change sitting
// uncommitted on main is invisible to the agent and the first question is "why can't it see my
// change"; a worktree that has fallen behind main gets told so where the next message is typed.

/** the base's uncommitted files, named before a worktree is made from it; null when none. The
 * line is terse like the others; `BASE_NOTE_TIP` says why it matters. */
export function baseNote(name: string, dirty: number | undefined): string | null {
  const n = dirty ?? 0;
  if (n === 0) return null;
  return `${n} uncommitted on ${name} stay behind`;
}

export const BASE_NOTE_TIP =
  "A new worktree starts from the base's last commit; what is uncommitted there is not in it";

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
