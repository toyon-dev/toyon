// Shell commands no agent runs, whichever agent it is. Shipping is the shell's (push, PRs), and the
// worktree list is the daemon's (branch deletion, `git worktree`). Each agent is told them in its own
// rule syntax. They are prefix matches on the text the model writes, so `git -C dir push` slips past:
// a filter for the honest case, not a wall.

export const DENIED_COMMANDS = [
  "git push",
  "git branch -D",
  "git branch -d",
  "git branch --delete",
  "git worktree",
  "gh pr create",
  "gh pr merge",
] as const;

/** Claude Code's form. Deny rules win over every allow in every settings scope and are checked even
 * when the sandbox auto-allows Bash; a compound command is split and each part matched. */
export function claudeDenyRules(): string[] {
  return DENIED_COMMANDS.map((c) => `Bash(${c}:*)`);
}
