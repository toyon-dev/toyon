import type { DaemonSocket } from "../ws.ts";
import type { Store } from "./context.tsx";

/** Open a file in the diff pane at a line the running page reported, and show the pane it lands
 * in. The line is numbered against the served module rather than the file on disk, so the reveal
 * waits on the changed-ranges offset that maps it back; the reducer places it whichever reply
 * arrives second. */
export function openSource(store: Store, sock: DaemonSocket | null, worktreeId: string, path: string, line: number) {
  const { leftOpen } = store.getState();
  store.dispatch({ a: "goto-line", v: { worktreeId, path, line, fiber: true } });
  sock?.send({ t: "file-diff", worktreeId, path });
  if (!leftOpen) store.dispatch({ a: "toggle-left" });
}
