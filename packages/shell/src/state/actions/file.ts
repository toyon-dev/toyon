import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { EditorView } from "../store.ts";
import type { Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";

const VIEWS: EditorView[] = ["diff", "file"];

/** open a file in the editor pane as its diff or as the file; a commit's copy names its `ref` */
export function openFile({ sock, dispatch }: Deps, worktreeId: string, path: string, view: EditorView, ref?: string) {
  dispatch({ a: "open-view", v: { worktreeId, path, view } });
  sock?.send({ t: "file-diff", worktreeId, path, ref });
}

/** a file in the changes panel: show it in the editor pane as its diff or as the file, open it
 * somewhere else, and for an uncommitted one, throw it away. `showing` is the view the pane already
 * has this file in, which the menu swaps rather than reads again; `ref` is the commit a history row
 * stands for. */
export function fileItems(
  wt: { id: string; dir: string },
  path: string,
  { discard = false, ref, showing }: { discard?: boolean; ref?: string; showing?: EditorView },
  deps: Deps,
): MenuEntry[] {
  const { sock, dispatch } = deps;
  const views: MenuItem[] = VIEWS.filter((v) => v !== showing).map((v) => ({
    id: `view:${v}`,
    label: `view ${v}`,
    onClick: () => (showing ? dispatch({ a: "editor-view", v }) : openFile(deps, wt.id, path, v, ref)),
  }));
  const open = editorItems(`${wt.dir}/${path}`, () => sock?.send({ t: "reveal", worktreeId: wt.id, path }));
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
  return grouped([views, open, discardItems]);
}
