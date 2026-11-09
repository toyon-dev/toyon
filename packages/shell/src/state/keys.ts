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
  /** "1" while the editor folds long lines at the pane's edge instead of scrolling sideways */
  editorWrap: "toyon-dwrap",
  /** "1" while a diff draws the old text beside the new instead of in one column */
  editorSplit: "toyon-dsplit",
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
  /** "1" while the phone frame stands its dark theme on black, for an OLED panel */
  blackGround: "toyon-black",
  /** "1" once the composer's one-time offer to install Toyon as an app was pressed or turned down */
  installOffered: "toyon-install-offered",
  /** every project's layout, keyed by repo id: {"<repo>":{changes,changesTab,chat,term,design}} */
  layouts: "toyon-layouts",
  /** this tab's id (sessionStorage): worktrees created here steal focus, others don't */
  client: "toyon-client",
  /** the token the screen this tab shows is painted in (sessionStorage): "surface0" | "surface1".
   * The boot script in index.html paints the page in it before the bundle runs, so a reload comes
   * up in the colour of the screen it returns to */
  ground: "toyon-ground",
  /** the daemon's version this browser last ran, per machine, so the first page after an update
   * can say what changed */
  version: "toyon-version",
} as const;

type Key = (typeof STORAGE)[keyof typeof STORAGE];

/** What is about this window, whichever machine it is looking at: how it looks and how it is laid
 * out, its token for the machine that served it, and the list of the others. */
export const WINDOW_KEYS: readonly Key[] = [
  STORAGE.theme,
  STORAGE.daylight,
  STORAGE.changesWidth,
  STORAGE.chatWidth,
  STORAGE.editorHeight,
  STORAGE.editorFull,
  STORAGE.editorWrap,
  STORAGE.editorSplit,
  STORAGE.designHeight,
  STORAGE.designFull,
  STORAGE.termHeight,
  STORAGE.rail,
  STORAGE.railWidth,
  STORAGE.chatSide,
  STORAGE.clipboardOffer,
  STORAGE.blackGround,
  STORAGE.installOffered,
  STORAGE.layouts,
  STORAGE.token,
  STORAGE.client,
  STORAGE.ground,
];

/** What is about one machine's projects and worktrees, whose ids mean nothing on another machine:
 * kept under that machine's origin, so two machines' selections never read each other's. */
export const MACHINE_KEYS: readonly Key[] = [
  STORAGE.active,
  STORAGE.repo,
  STORAGE.lastActive,
  STORAGE.discoveredOpen,
  STORAGE.archivedOpen,
  STORAGE.committedShut,
  STORAGE.turnOpen,
  STORAGE.treeOpen,
  STORAGE.phoneRow,
  STORAGE.version,
];

/** the storage a scope reads and writes: localStorage, or a stand-in in a test */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** a key for one machine: the key, then the machine's origin after an `@`, which no key or origin
 * contains */
export const scopedKey = (key: string, origin: string) => `${key}@${origin}`;

/** What a machine leaves in IndexedDB, beside what it leaves in localStorage, so this file lists
 * everything of a machine's in this browser: its last hello and the chats opened there
 * (snapshot.ts, kept by snapshotStore.ts). One database, one object store, keyed the same way as
 * above, with the chat's worktree id after a slash. */
export const SNAPSHOT_DB = "toyon";
export const SNAPSHOT_STORE = "snapshots";
export const snapshotKey = {
  hello: (origin: string) => `hello@${origin}`,
  chat: (origin: string, id: string) => `chat@${origin}/${id}`,
  /** the prefix every chat key of a machine starts with */
  chats: (origin: string) => `chat@${origin}/`,
};

/** One machine's view of storage: every read and write lands under that machine's origin, and the
 * try/catch every storage call needs (a private window, a full quota) is here once. `session` is
 * the same over sessionStorage, for what is this tab's alone. */
export interface ScopedStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  session: { get(key: string): string | null; set(key: string, value: string): void };
  /** every key under this scope, gone: for a machine being forgotten */
  clear(): void;
}

export function storageFor(
  origin: string,
  local: KeyStore | null = typeof localStorage === "undefined" ? null : localStorage,
  session: KeyStore | null = typeof sessionStorage === "undefined" ? null : sessionStorage,
): ScopedStorage {
  const over = (store: KeyStore | null) => ({
    get(key: string): string | null {
      try {
        return store?.getItem(scopedKey(key, origin)) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string) {
      try {
        store?.setItem(scopedKey(key, origin), value);
      } catch {
        // storage blocked (a private window) or full: the page still works, only the memory is lost
      }
    },
    remove(key: string) {
      try {
        store?.removeItem(scopedKey(key, origin));
      } catch {
        // as above
      }
    },
  });
  const l = over(local);
  const s = over(session);
  return {
    ...l,
    session: { get: s.get, set: s.set },
    clear() {
      for (const store of [local, session]) {
        for (const key of keysOf(store).filter((k) => k.endsWith(`@${origin}`))) {
          try {
            store?.removeItem(key);
          } catch {
            // as above
          }
        }
      }
    },
  };
}

/** every key a store holds, read up front: removing while walking by index skips every other one */
function keysOf(store: KeyStore | null): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < (store?.length ?? 0); i++) {
      const k = store?.key(i);
      if (k !== null && k !== undefined) out.push(k);
    }
  } catch {
    // storage blocked: nothing to list
  }
  return out;
}

/** the same keys under the pre-rename prefix; migrated once on load so nobody loses a token or layout */
const LEGACY_PREFIX = "orch-";

/** Storage as earlier builds left it, brought to the shape this one reads: the pre-rename prefix
 * first, then every machine key written bare (before the page could show more than the machine
 * that served it) moved once under the serving machine's scope. Each is idempotent, since a
 * reload runs it again, and a value already in the new place is never overwritten. */
export function migrateStorage(
  servingOrigin: string,
  local: KeyStore | null = typeof localStorage === "undefined" ? null : localStorage,
  session: KeyStore | null = typeof sessionStorage === "undefined" ? null : sessionStorage,
) {
  for (const [storage, keys] of [
    [local, ["active", "token", "theme", "editorHeight", "editorFull"]],
    [session, ["client"]],
  ] as const) {
    for (const k of keys) {
      const next = STORAGE[k];
      const legacy = LEGACY_PREFIX + next.slice("toyon-".length);
      move(storage, legacy, next);
    }
  }
  for (const [storage, held] of [
    [local, MACHINE_KEYS.filter((k) => k !== STORAGE.phoneRow)],
    [session, [STORAGE.phoneRow]],
  ] as const) {
    const bare = keysOf(storage).filter((k) => !k.includes("@"));
    for (const key of held) {
      for (const k of bare.filter((k) => k === key)) move(storage, k, scopedKey(k, servingOrigin));
    }
  }
  // what a new worktree starts with (mode and profile per repo, model and effort per agent) is the
  // daemon's memory now, and the mono face is the shell's own with no pick to keep: what this
  // browser kept under the old keys, scoped or not, is dead
  for (const k of keysOf(local)) {
    if (DEAD_PREFIXES.some((p) => k.startsWith(p))) remove(local, k);
  }
}

/** keys read by nothing now: prefixes once completed by a repo or agent id, and the mono face pick */
const DEAD_PREFIXES = ["toyon-profile-", "toyon-mode-", "toyon-model-", "toyon-effort-", "toyon-mono-face"];

function remove(store: KeyStore | null, key: string) {
  try {
    store?.removeItem(key);
  } catch {
    // storage blocked: the page starts as a fresh one would
  }
}

function move(store: KeyStore | null, from: string, to: string) {
  try {
    const v = store?.getItem(from);
    if (v === null || v === undefined) return;
    if (store?.getItem(to) === null) store.setItem(to, v);
    store?.removeItem(from);
  } catch {
    // storage blocked: the page starts as a fresh one would
  }
}
