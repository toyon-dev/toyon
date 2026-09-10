/** every localStorage key the shell uses, in one place */
export const STORAGE = {
  /** last selected worktree id, restored on reload */
  active: "toyon-active",
  /** last selected project (repo id), restored on reload */
  repo: "toyon-repo",
  /** the worktree each project was left on, keyed by repo id: {"<repo>":"<worktree>"} */
  lastActive: "toyon-last",
  /** which projects had the rail's discovered section open, keyed by repo id */
  discoveredOpen: "toyon-disc",
  /** daemon token; an installed PWA launches without the #token fragment */
  token: "toyon-token",
  /** last painted theme, applied before the daemon's hello to avoid a flash */
  theme: "toyon-theme",
  leftWidth: "toyon-lw",
  rightWidth: "toyon-rw",
  diffHeight: "toyon-dh",
  diffFull: "toyon-dfull",
  designHeight: "toyon-dsh",
  designFull: "toyon-dsfull",
  termHeight: "toyon-th",
  /** the worktree panel is kept open instead of peeking on hover */
  rail: "toyon-rail",
  /** every project's panel layout, keyed by repo id: {"<repo>":{left,right,term,design}} */
  panels: "toyon-panels",
  /** this tab's id (sessionStorage): worktrees created here steal focus, others don't */
  client: "toyon-client",
  /** + repo id: the profile the composer last started a worktree with, for that repo */
  profilePrefix: "toyon-profile-",
} as const;

/** the same keys under the pre-rename prefix; migrated once on load so nobody loses a token or layout */
const LEGACY_PREFIX = "orch-";
export function migrateStorage() {
  for (const [storage, keys] of [
    [localStorage, ["active", "token", "theme", "leftWidth", "rightWidth", "diffHeight", "diffFull"]],
    [sessionStorage, ["client"]],
  ] as const) {
    for (const k of keys) {
      const next = STORAGE[k];
      const legacy = LEGACY_PREFIX + next.slice("toyon-".length);
      try {
        const v = storage.getItem(legacy);
        if (v !== null) {
          if (storage.getItem(next) === null) storage.setItem(next, v);
          storage.removeItem(legacy);
        }
      } catch {}
    }
  }
}
