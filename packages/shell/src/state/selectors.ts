// Selector hooks. Each returns a field or a stable constant so a component re-renders only when
// what it reads changes (useSyncExternalStore compares by identity: never build a fresh object here).

import type { ArchivedWorktree, OwnedWorktree, RepoInfo, WorktreeStatus } from "@toyon/shared";
import { useSettled } from "../ui/hooks.ts";
import { useStore } from "./context.tsx";
import {
  currentTheme,
  draftSpareOf,
  isGreenfield,
  localOf,
  previewIdOf,
  repoById,
  rowById,
  type WorktreeLocal,
  worktreeById,
} from "./store.ts";

export const useActiveId = () => useStore((s) => s.activeId);

/** the socket has been down long enough to be worth saying so. It is down on first paint and for
 * a blink on every reconnect; painting either reads as the app still loading. */
export const useOffline = (): boolean => useSettled(!useStore((s) => s.connected), 900);

/** the active row when toyon owns it: what the chat, the composer and landing read. Null while a
 * found worktree is selected, so nothing that writes or talks to an agent sees one. Its identity
 * changes with every worktrees/proc message. */
export const useActive = (): OwnedWorktree | null => useStore((s) => worktreeById(s, s.activeId));

/** the active row whoever owns it: the title, the pane, the dock and the rail read this one */
export const useActiveRow = (): WorktreeStatus | null => useStore((s) => rowById(s, s.activeId));

export const useRows = () => useStore((s) => s.rows);

/** the active project's owned worktrees in rail order (state/railOrder.ts): what the rail lists and
 * ⌘1-9 count over */
export const useVisibleWorktrees = () => useStore((s) => s.visible);

/** the active project's worktrees that toyon did not create. A separate list from `visible` on
 * purpose: ⌘1-9 and the palette number that one positionally. */
export const useVisibleDiscovered = () => useStore((s) => s.visibleDiscovered);

/** has the discovered section been opened in this project (collapsed by default) */
export const useDiscoveredOpen = (): boolean =>
  useStore((s) => (s.activeRepoId ? (s.discoveredOpen[s.activeRepoId] ?? false) : false));

const NO_ARCHIVED: ArchivedWorktree[] = [];

/** the active project's archived worktrees, newest first; the same empty list until the daemon answers */
export const useVisibleArchived = (): ArchivedWorktree[] =>
  useStore((s) => (s.activeRepoId ? (s.archived[s.activeRepoId] ?? NO_ARCHIVED) : NO_ARCHIVED));

/** has the archived section been opened in this project (collapsed by default) */
export const useArchivedOpen = (): boolean =>
  useStore((s) => (s.activeRepoId ? (s.archivedOpen[s.activeRepoId] ?? false) : false));

/** the project the shell is scoped to (an element of the repos array, so its identity is stable) */
export const useActiveRepo = (): RepoInfo | null => useStore((s) => repoById(s, s.activeRepoId));

/** the per-worktree record (the shared EMPTY_LOCAL when unknown, so the identity is stable).
 * Prefer useLocalField: the record's identity changes on every log line and keystroke. */
export const useLocal = (id: string | null | undefined): WorktreeLocal => useStore((s) => localOf(s, id));

/** one field of the per-worktree record; unchanged fields keep their identity across updates */
export const useLocalField = <K extends keyof WorktreeLocal>(id: string | null | undefined, key: K): WorktreeLocal[K] =>
  useStore((s) => localOf(s, id)[key]);

export const useOverlay = () => useStore((s) => s.overlay);

/** the theme to paint right now (an element of the themes array, so its identity is stable) */
export const useTheme = () => useStore(currentTheme);

/** an empty project nobody has spoken to yet: the composer sits in the centre, the chat dock is hidden */
export const useGreenfield = (): boolean => useStore(isGreenfield);

/** the new worktree being drafted, while the draft tab is open */
export const useDraft = () => useStore((s) => s.draft);

/** the spare whose preview the draft shows (an element of the spares array); null when the draft
 * is not from main, none is ready, or there is no draft */
export const useDraftSpare = () => useStore(draftSpareOf);

/** the preview on screen: what the element picker and the page context are about */
export const usePreviewId = () => useStore(previewIdOf);

/** the active worktree's repo while its detected config is still unconfirmed (an element of the repos array) */
export const useActiveRepoNeedingSetup = () =>
  useStore((s) => {
    const wt = rowById(s, s.activeId);
    const repo = wt ? s.repos.find((r) => r.id === wt.repoId) : null;
    return repo?.needsSetup ? repo : null;
  });
