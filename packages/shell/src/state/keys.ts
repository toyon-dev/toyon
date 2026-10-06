/** every localStorage key the shell uses, in one place */
export const STORAGE = {
  /** last selected worktree id, restored on reload */
  active: "toyon-active",
  /** "1" while the phone frame is on a row (sessionStorage): a reload of this tab comes back to
   * the row, and a fresh launch opens the list */
  phoneRow: "toyon-phone-row",
  /** last selected project (repo id), restored on reload */
  repo: "toyon-repo",
  /** the worktree each project was left on, keyed by repo id: {"<repo>":"<worktree>"} */
  lastActive: "toyon-last",
  /** which projects had the rail's discovered section open, keyed by repo id */
  discoveredOpen: "toyon-disc",
  /** which projects had the rail's archived section open, keyed by repo id */
  archivedOpen: "toyon-arch",
  /** which projects had the changes list's committed section folded, keyed by repo id */
  committedShut: "toyon-committed-shut",
  /** which projects had the changes list's last turn section open, keyed by repo id */
  turnOpen: "toyon-turn-open",
  /** the folders opened by hand in the files tab, keyed by worktree id: {"<worktree>":["src",...]} */
  treeOpen: "toyon-tree",
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
  /** the worktree panel's width, dragged from its seam while kept open */
  railWidth: "toyon-rail-w",
  /** which side of the window the chat dock stands on, the rail outside it: "left" | "right" */
  chatSide: "toyon-chat-side",
  /** "1" while the composer offers what is on the clipboard */
  clipboardOffer: "toyon-clipboard-offer",
  /** every project's layout, keyed by repo id: {"<repo>":{changes,changesTab,chat,term,design}} */
  layouts: "toyon-layouts",
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
