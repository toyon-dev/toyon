// Selector hooks. Each returns a field or a stable constant so a component re-renders only when
// what it reads changes (useSyncExternalStore compares by identity: never build a fresh object here).

import type { WorktreeStatus } from "@toyon/shared";
import { useStore } from "./context.tsx";
import { currentTheme, localOf, type State, type WorktreeLocal } from "./store.ts";

export const useActiveId = () => useStore((s) => s.activeId);

/** the active worktree's status row (identity changes with every worktrees/proc message, like before) */
export const useActive = (): WorktreeStatus | null =>
  useStore((s) => s.worktrees.find((w) => w.worktree.id === s.activeId) ?? null);

export const useWorktrees = () => useStore((s) => s.worktrees);

/** the per-worktree record (the shared EMPTY_LOCAL when unknown, so the identity is stable) */
export const useLocal = (id: string | null | undefined): WorktreeLocal => useStore((s) => localOf(s, id));

export const useOverlay = () => useStore((s) => s.overlay);

/** the theme to paint right now (an element of the themes array, so its identity is stable) */
export const useTheme = () => useStore(currentTheme);

export const useField = <K extends keyof State>(k: K) => useStore((s) => s[k]);
