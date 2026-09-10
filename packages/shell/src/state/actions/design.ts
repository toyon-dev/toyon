import type { MenuItem } from "../../ui/menu.ts";
import { copyText, type Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";

/** a row of the design pane's inventory: the file it came from, opened here or elsewhere */
export function designRowItems(
  wt: { id: string; dir: string },
  path: string | undefined,
  { sock }: Deps,
  onOpen: () => void,
): MenuItem[] {
  if (!path) return [];
  return [
    { id: "source", label: "open source", onClick: onOpen },
    ...editorItems(`${wt.dir}/${path}`, () => sock?.send({ t: "reveal", worktreeId: wt.id, path })),
    { id: "copy-path", label: "copy path", onClick: () => copyText(path) },
  ];
}
