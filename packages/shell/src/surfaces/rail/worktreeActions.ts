import type { WorktreeStatus } from "@toyon/shared";
import type { DaemonSocket } from "../../ws.ts";

/** confirm-then-send worktree actions, shared by the rail's context menu and the ⌘⇧P palette */
export function worktreeActions(sock: DaemonSocket | null) {
  return {
    rename(w: WorktreeStatus) {
      if (w.worktree.kind === "main") return;
      const title = window.prompt("Rename worktree (also renames its branch):", w.worktree.title);
      if (title?.trim()) sock?.send({ t: "rename-worktree", worktreeId: w.worktree.id, title: title.trim() });
    },
    pickVariant(w: WorktreeStatus) {
      const v = w.worktree.variant;
      if (!v) return;
      const others = v.of - 1;
      if (
        window.confirm(
          `Keep "${w.worktree.title}" and remove ${others} sibling variant(s)? Their branches and changes are deleted.`,
        )
      ) {
        sock?.send({ t: "pick-variant", worktreeId: w.worktree.id });
      }
    },
    remove(w: WorktreeStatus) {
      if (w.worktree.kind === "main") return;
      const ok = window.confirm(
        `Remove worktree "${w.worktree.title}"?\n\nThis deletes its directory and branch (${w.worktree.branch}). Unmerged changes are lost.`,
      );
      if (ok) sock?.send({ t: "remove-worktree", worktreeId: w.worktree.id });
    },
  };
}
