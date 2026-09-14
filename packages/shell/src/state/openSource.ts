import type { DaemonSocket } from "../ws.ts";
import { openFile } from "./actions/file.ts";
import type { Store } from "./context.tsx";

/** Open a file in the editor pane at a line the running page reported, and show the pane it lands
 * in. It opens as the file with its edits, not the diff: the page points at a line of code, as a
 * search hit does. The line is numbered against the served module rather than the file on disk, so
 * the open file holds it until the changed-ranges offset that maps it back is known. */
export function openSource(store: Store, sock: DaemonSocket | null, worktreeId: string, path: string, line: number) {
  const { changesOpen } = store.getState();
  openFile({ sock, dispatch: store.dispatch }, { worktreeId, path, view: "file", line: { n: line, fiber: true } });
  if (!changesOpen) store.dispatch({ a: "toggle-changes" });
}
