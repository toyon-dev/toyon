// A file the daemon opened on someone's behalf from outside the shell: the Dock icon, or
// `toyon <file>` in a terminal. In a worktree, it opens there as any file does; outside every
// project, it opens loose under the daemon's grant, on whichever worktree is on screen.

import type { ServerMsg } from "@toyon/shared";
import type { DaemonSocket } from "../ws.ts";
import { nextSeq, openFile } from "./actions/file.ts";
import type { Store } from "./context.tsx";
import { rowById } from "./store.ts";

export type OpenedMsg = Extract<ServerMsg, { t: "open-path" | "open-loose" }>;

export const isOpenedMsg = (m: ServerMsg): m is OpenedMsg => m.t === "open-path" || m.t === "open-loose";

export function openFromOutside(store: Store, sock: DaemonSocket | null, msg: OpenedMsg) {
  const s = store.getState();
  if (msg.t === "open-path") {
    const deps = { sock, dispatch: (a: Parameters<Store["dispatch"]>[0]) => store.dispatch(a) };
    if (rowById(s, msg.worktreeId)) {
      if (s.activeId !== msg.worktreeId) store.dispatch({ a: "activate", id: msg.worktreeId });
      openFile(deps, { worktreeId: msg.worktreeId, path: msg.path });
      return;
    }
    // main's checkout has no row of its own while a spare stands in for it, and cannot be selected;
    // its file opens on the project's row on screen, or the project's first row when another
    // project is. The daemon reads and saves it by main's id all the same.
    const repoId = Object.keys(s.trunks).find((r) => s.trunks[r]?.id === msg.worktreeId);
    if (!repoId) return;
    if (rowById(s, s.activeId)?.repoId !== repoId) {
      const row = s.rows.find((r) => r.repoId === repoId);
      if (!row) return;
      store.dispatch({ a: "activate", id: row.id });
    }
    openFile(deps, { worktreeId: msg.worktreeId, path: msg.path });
    return;
  }
  const worktreeId = s.activeId;
  if (!worktreeId) {
    store.dispatch({
      a: "server",
      msg: { t: "error", message: `open a project first; ${msg.name} needs a window to open in` },
    });
    return;
  }
  store.dispatch({
    a: "open-loose",
    v: {
      worktreeId,
      name: msg.name,
      text: msg.text,
      tooLarge: msg.tooLarge,
      source: { kind: "grant", id: msg.id, version: msg.version },
      seq: nextSeq(),
    },
  });
}
