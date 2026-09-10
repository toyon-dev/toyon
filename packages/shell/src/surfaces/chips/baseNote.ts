// What a prompt says about the worktree it is about to branch from, or about the one it is
// talking to. A new worktree starts from its base's last commit, so a half-done change sitting
// uncommitted on main is invisible to the agent and the first question is "why can't it see my
// change"; a worktree that has fallen behind main gets told so where the next message is typed.

/** the base's uncommitted files, named before a worktree is made from it; null when none */
export function baseNote(name: string, dirty: number | undefined): string | null {
  const n = dirty ?? 0;
  if (n === 0) return null;
  return `${name} has ${n} uncommitted ${n === 1 ? "file" : "files"}; the new worktree starts from its last commit`;
}

/** how far a worktree trails its default branch; null when it does not */
export function behindNote(defaultBranch: string, behind: number | undefined): string | null {
  const n = behind ?? 0;
  if (n === 0) return null;
  return `${n} ${n === 1 ? "commit" : "commits"} behind ${defaultBranch}`;
}
