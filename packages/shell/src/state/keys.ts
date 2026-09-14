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
  /** which projects had the rail's archived section open, keyed by repo id */
  archivedOpen: "toyon-arch",
  /** the unsent text in every composer box, keyed by box id (a worktree id, or a repo's draft key),
   * so a reload gives back what was being written: {"<box>":"<text>"} */
  drafts: "toyon-drafts",
  /** daemon token; an installed PWA launches without the #token fragment */
  token: "toyon-token",
  /** last painted theme, applied before the daemon's hello to avoid a flash */
  theme: "toyon-theme",
  /** the daemon's last answer about the sun, so a page that opens while following daylight paints
   * from it rather than waiting a round trip: {"dark":true,"until":<epoch ms>} */
  daylight: "toyon-sun",
  changesWidth: "toyon-changes-w",
  chatWidth: "toyon-chat-w",
  editorHeight: "toyon-dh",
  editorFull: "toyon-dfull",
  designHeight: "toyon-dsh",
  designFull: "toyon-dsfull",
  termHeight: "toyon-th",
  /** the worktree panel is kept open instead of peeking on hover */
  rail: "toyon-rail",
  /** which side of the window the chat dock stands on, the rail outside it: "left" | "right" */
  chatSide: "toyon-chat-side",
  /** every project's panel layout, keyed by repo id: {"<repo>":{changes,chat,term,design}} */
  panels: "toyon-panels",
  /** this tab's id (sessionStorage): worktrees created here steal focus, others don't */
  client: "toyon-client",
  /** + repo id: the profile the composer last started a worktree with, for that repo */
  profilePrefix: "toyon-profile-",
  /** + repo id: the permission mode the composer last started a worktree with, for that repo */
  modePrefix: "toyon-mode-",
  /** + agent id: the model the composer last started a worktree with, for that agent */
  modelPrefix: "toyon-model-",
  /** + agent id: the effort level the composer last started a worktree with, for that agent */
  effortPrefix: "toyon-effort-",
} as const;

/** the same keys under the pre-rename prefix; migrated once on load so nobody loses a token or layout */
const LEGACY_PREFIX = "orch-";
export function migrateStorage() {
  for (const [storage, keys] of [
    [localStorage, ["active", "token", "theme", "editorHeight", "editorFull"]],
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
