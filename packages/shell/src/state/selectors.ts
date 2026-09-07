// Selector hooks. Each returns a field or a stable constant so a component re-renders only when
// what it reads changes (useSyncExternalStore compares by identity: never build a fresh object here).

import type { RepoInfo, WorktreeStatus } from "@toyon/shared";
import { useStore } from "./context.tsx";
import { currentTheme, localOf, repoById, type WorktreeLocal, worktreeById } from "./store.ts";

export const useActiveId = () => useStore((s) => s.activeId);

/** the active worktree's status row (identity changes with every worktrees/proc message, like before) */
export const useActive = (): WorktreeStatus | null => useStore((s) => worktreeById(s, s.activeId));

export const useWorktrees = () => useStore((s) => s.worktrees);

/** the active project's worktrees: what the rail lists and ⌘1–9 count over */
export const useVisibleWorktrees = () => useStore((s) => s.visible);

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
