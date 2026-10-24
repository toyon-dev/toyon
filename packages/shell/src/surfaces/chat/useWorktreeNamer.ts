import { useMemo } from "react";
import { useStore } from "../../state/context.tsx";
import { worktreeById } from "../../state/store.ts";
import { namerFrom, namesKey, type WorktreeNamer } from "./markdownWorktree.ts";

/** the lookup that reads a `wt-xxxx` in a chat's prose as the row of the project it names; none
 * for a chat with no project (an archive's page, a draft). Remade only when a name moves: the
 * rows themselves change on every status tick, and every message of the chat holds one of these. */
export function useWorktreeNamer(worktreeId: string | null | undefined): WorktreeNamer | undefined {
  const repoId = useStore((s) => worktreeById(s, worktreeId)?.worktree.repoId);
  const key = useStore((s) => (repoId ? namesKey(s, repoId) : ""));
  return useMemo(() => (key ? namerFrom(key) : undefined), [key]);
}
