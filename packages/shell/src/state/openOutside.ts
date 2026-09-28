// A file the daemon opened on someone's behalf from outside the shell: the Dock icon, `toyon
// <file>` in a terminal, or a link in the chat to a file outside this worktree. In a worktree, it
// opens there as any file does; outside every project, it opens loose under the daemon's grant,
// on whichever worktree is on screen.

import type { ServerMsg } from "@toyon/shared";
import type { DaemonSocket } from "../ws.ts";
import { nextSeq, openFile } from "./actions/file.ts";
import type { Store } from "./context.tsx";
import { rowById } from "./store.ts";

export type OpenedMsg = Extract<ServerMsg, { t: "open-path" | "open-loose" }>;

export const isOpenedMsg = (m: ServerMsg): m is OpenedMsg => m.t === "open-path" || m.t === "open-loose";

type Dispatch = (a: Parameters<Store["dispatch"]>[0]) => void;

/** the opens this shell asked for by path, by the seq each went out with. A refusal comes back by
 * seq and is read at the link that asked; an open comes back as the frame the Dock's opens use,
 * with no seq, so an entry outlives its success and the map is kept to the last few. */
const asked = new Map<number, { worktreeId: string; href: string }>();
const ASKED_KEPT = 16;

/** a link in the chat to a file outside this worktree: ask the daemon to open it by its absolute
 * path. `href` is the link as written, which is how a refusal finds it again in the message. */
export function openByPath(
  { sock, dispatch }: { sock: DaemonSocket | null; dispatch: Dispatch },
  worktreeId: string,
  link: { href: string; path: string },
) {
  const seq = nextSeq();
  asked.set(seq, { worktreeId, href: link.href });
  for (const k of asked.keys()) {
    if (asked.size <= ASKED_KEPT) break;
    asked.delete(k);
  }
  // a new press answers the last refusal, whichever link it was on
  dispatch({ a: "link-refused", id: worktreeId, v: null });
  sock?.send({ t: "open-by-path", path: link.path, seq });
}

/** the daemon could not open what a link asked for: said at that link */
export function refusedFromOutside(store: Store, msg: Extract<ServerMsg, { t: "open-refused" }>) {
  const ask = asked.get(msg.seq);
  if (!ask) return;
  asked.delete(msg.seq);
  store.dispatch({ a: "link-refused", id: ask.worktreeId, v: { href: ask.href, message: msg.message } });
}

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
      binary: msg.binary,
      tooLarge: msg.tooLarge,
      source: { kind: "grant", id: msg.id, path: msg.path, version: msg.version },
      seq: nextSeq(),
    },
  });
}
