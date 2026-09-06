import type { TermServerMsg } from "@toyon/shared";

type Listener = (msg: TermServerMsg) => void;
const listeners = new Map<string, Set<Listener>>();

/** Terminal frames go around the store: xterm consumes them straight off the socket, since a
 * reducer pass per output chunk would copy a per-worktree record at scroll speed. The pane
 * subscribes by worktree id; main.tsx delivers. */
export const terminalBus = {
  on(worktreeId: string, fn: Listener): () => void {
    let set = listeners.get(worktreeId);
    if (!set) {
      set = new Set();
      listeners.set(worktreeId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) listeners.delete(worktreeId);
    };
  },
  deliver(msg: TermServerMsg) {
    for (const fn of listeners.get(msg.worktreeId) ?? []) fn(msg);
  },
};
