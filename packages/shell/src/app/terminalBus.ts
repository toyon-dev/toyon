import { streamKey, type TermServerMsg } from "@toyon/shared";

type Listener = (msg: TermServerMsg) => void;

/** Terminal frames go around the store: xterm consumes them straight off the socket, since a
 * reducer pass per output chunk would copy a per-worktree record at scroll speed. A tab
 * subscribes by `worktreeId/stream`; the machine's socket router delivers. One bus per machine,
 * because worktree ids are the daemon's and two daemons can hand out the same one. */
export interface TerminalBus {
  on(key: string, fn: Listener): () => void;
  deliver(msg: TermServerMsg): void;
}

export function createTerminalBus(): TerminalBus {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(key, fn) {
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
    deliver(msg) {
      for (const fn of listeners.get(streamKey(msg.worktreeId, msg.stream)) ?? []) fn(msg);
    },
  };
}
