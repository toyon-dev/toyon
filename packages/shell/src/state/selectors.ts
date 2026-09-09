// Selector hooks. Each returns a field or a stable constant so a component re-renders only when
// what it reads changes (useSyncExternalStore compares by identity: never build a fresh object here).

import type { DiscoveredWorktree, RepoInfo, WorktreeStatus } from "@toyon/shared";
import { useSettled } from "../ui/hooks.ts";
import { useStore } from "./context.tsx";
import { currentTheme, localOf, repoById, type WorktreeLocal, worktreeById } from "./store.ts";

export const useActiveId = () => useStore((s) => s.activeId);

/** the socket has been down long enough to be worth saying so. It is down on first paint and for
 * a blink on every reconnect; painting either reads as the app still loading. */
export const useOffline = (): boolean => useSettled(!useStore((s) => s.connected), 900);

/** the active worktree's status row (identity changes with every worktrees/proc message, like before) */
export const useActive = (): WorktreeStatus | null => useStore((s) => worktreeById(s, s.activeId));

export const useWorktrees = () => useStore((s) => s.worktrees);

/** the active project's worktrees: what the rail lists and ⌘1–9 count over */
export const useVisibleWorktrees = () => useStore((s) => s.visible);

/** the active project's worktrees that toyon did not create. A separate list from `visible` on
 * purpose: ⌘1-9 and the palette number that one positionally. */
export const useVisibleDiscovered = () => useStore((s) => s.visibleDiscovered);

/** the discovered worktree that is selected, when the selection is one of those rather than a
 * worktree toyon runs. Exactly one of this and `useActive()` is ever set. */
export const useActiveDiscovered = (): DiscoveredWorktree | null =>
  useStore((s) => (s.activeId ? (s.discovered.find((d) => d.id === s.activeId) ?? null) : null));

/** has the discovered section been opened in this project (collapsed by default) */
export const useDiscoveredOpen = (): boolean =>
  useStore((s) => (s.activeRepoId ? (s.discoveredOpen[s.activeRepoId] ?? false) : false));

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

/** the active worktree's repo while its detected config is still unconfirmed (an element of the repos array) */
export const useActiveRepoNeedingSetup = () =>
  useStore((s) => {
    const wt = worktreeById(s, s.activeId);
    const repo = wt ? s.repos.find((r) => r.id === wt.worktree.repoId) : null;
    return repo?.needsSetup ? repo : null;
  });
