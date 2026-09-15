import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { EditorView, OpenFile } from "../store.ts";
import { copyText, type Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";

const VIEWS: EditorView[] = ["diff", "file"];

let lastSeq = 0;
/** pairs a request with its answer; one counter for the page, so no two opens share a number */
export const nextSeq = () => ++lastSeq;

/** what a caller asks to open; the keyboard follows unless the caller is walking a list */
export type OpenRequest = Omit<OpenFile, "seq" | "focus"> & { focus?: boolean };

/** Open a file in the editor pane: as its diff or as the file (unsaid, the read decides), at a
 * line, or as a commit left it (`ref`). The pane opens now, loading; fileSync sees the open, reads
 * the file and keeps it in step with the disk from there. */
export function openFile({ dispatch }: Deps, { focus = true, ...target }: OpenRequest) {
  dispatch({ a: "open-file", v: { ...target, focus, seq: nextSeq() } });
}

/** a file in the changes panel: show it in the editor pane as its diff or as the file, open it
 * somewhere else, copy where it is, and for an uncommitted one, throw it away. `showing` is the view the pane already
 * has this file in, which the menu swaps rather than reads again; `ref` is the commit a history row
 * stands for; `added` says the file has nothing on the other side, so no diff to offer. */
export function fileItems(
  wt: { id: string; dir: string },
  path: string,
  {
    discard = false,
    ref,
    showing,
    added = false,
  }: { discard?: boolean; ref?: string; showing?: EditorView; added?: boolean },
  deps: Deps,
): MenuEntry[] {
  const { sock, dispatch } = deps;
  const views: MenuItem[] = VIEWS.filter((v) => v !== showing && !(added && v === "diff")).map((v) => ({
    id: `view:${v}`,
    label: `view ${v}`,
    onClick: () =>
      showing ? dispatch({ a: "editor-view", v }) : openFile(deps, { worktreeId: wt.id, path, view: v, ref }),
  }));
  const abs = `${wt.dir}/${path}`;
  const open = editorItems(abs, () => sock?.send({ t: "reveal", worktreeId: wt.id, path }));
  const copy: MenuItem[] = [{ id: "copy-path", label: "copy path", onClick: () => copyText(abs) }];
  const discardItems = discard
    ? [
        {
          id: "discard",
          label: "discard changes…",
          danger: true,
          onClick: () => {
            if (window.confirm(`Discard uncommitted changes to ${path}?`)) {
              sock?.send({ t: "discard-file", worktreeId: wt.id, path });
            }
          },
        },
      ]
    : [];
  return grouped([views, copy, open, discardItems]);
}
