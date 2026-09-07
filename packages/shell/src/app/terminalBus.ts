import { streamKey, type TermServerMsg } from "@toyon/shared";

type Listener = (msg: TermServerMsg) => void;
const listeners = new Map<string, Set<Listener>>();

/** Terminal frames go around the store: xterm consumes them straight off the socket, since a
 * reducer pass per output chunk would copy a per-worktree record at scroll speed. A tab
 * subscribes by `worktreeId/stream`; main.tsx delivers. */
export const terminalBus = {
  on(key: string, fn: Listener): () => void {
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) listeners.delete(key);
    };
  },
  deliver(msg: TermServerMsg) {
    for (const fn of listeners.get(streamKey(msg.worktreeId, msg.stream)) ?? []) fn(msg);
  },
};
