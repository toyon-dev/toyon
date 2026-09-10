import type { ClientMsg, WorktreeStatus } from "@toyon/shared";
import type { Action, ShipOp } from "../../state/store.ts";
import type { DaemonSocket } from "../../ws.ts";

type Dispatch = (a: Action) => void;

/** send a landing op (sync, merge, ship, commit) and mark the worktree in flight in the same
 * breath, so no sender can send without the rail's dot and the changes panel's button showing
 * it working. The shipped frame brings it to rest; see `shipping` in the store. */
export function shipOp(sock: DaemonSocket | null, dispatch: Dispatch, msg: Extract<ClientMsg, { t: ShipOp }>) {
  dispatch({ a: "shipping", id: msg.worktreeId, op: msg.t });
  sock?.send(msg);
}

/** send the removes and take the rows off screen in the same breath: the daemon confirms by
 * dropping them from its next snapshot, or an error frame puts them back with a toast */
export function removeWorktrees(sock: DaemonSocket | null, dispatch: Dispatch, ids: string[]) {
  if (ids.length === 0) return;
  dispatch({ a: "remove-worktrees", ids });
  for (const id of ids) sock?.send({ t: "remove-worktree", worktreeId: id });
}

/** confirm-then-send worktree actions, shared by the rail's context menu and the ⌘⇧P palette */
export function worktreeActions(sock: DaemonSocket | null, dispatch: Dispatch) {
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
    /** run under another profile: only its procs restart, so no confirm */
    setProfile(w: WorktreeStatus, profile: string) {
      sock?.send({ t: "set-worktree-profile", worktreeId: w.worktree.id, profile });
    },
    remove(w: WorktreeStatus) {
      if (w.worktree.kind === "main") return;
      const ok = window.confirm(
        `Remove worktree "${w.worktree.title}"?\n\nThis deletes its directory and branch (${w.worktree.branch}). Unmerged changes are lost.`,
      );
      if (ok) removeWorktrees(sock, dispatch, [w.worktree.id]);
    },
  };
}
