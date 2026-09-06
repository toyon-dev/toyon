/** every localStorage key the shell uses, in one place (they were literals across four files) */
export const STORAGE = {
  /** last selected worktree id, restored on reload */
  active: "orch-active",
  /** daemon token; an installed PWA launches without the #token fragment */
  token: "orch-token",
  /** last painted theme, applied before the daemon's hello to avoid a flash */
  theme: "orch-theme",
  leftWidth: "orch-lw",
  rightWidth: "orch-rw",
  diffHeight: "orch-dh",
  diffFull: "orch-dfull",
  /** this tab's id (sessionStorage): worktrees created here steal focus, others don't */
  client: "orch-client",
} as const;
