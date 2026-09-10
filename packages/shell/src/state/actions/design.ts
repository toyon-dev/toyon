import { grouped, type MenuEntry } from "../../ui/menu.ts";
import { copyText, type Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";

/** a token or a face in the design pane: nothing to open, since a value has no line to go to,
 * but the name and the value are both things to paste */
export function designTokenItems(name: string, value: string): MenuEntry[] {
  return [
    { id: "copy-name", label: "copy name", detail: name, onClick: () => copyText(name) },
    { id: "copy-value", label: "copy value", detail: value, onClick: () => copyText(value) },
  ];
}

/** a row of the design pane's inventory: the file it came from, opened here or elsewhere */
export function designRowItems(
  wt: { id: string; dir: string },
  path: string | undefined,
  { sock }: Deps,
  onOpen: () => void,
): MenuEntry[] {
  if (!path) return [];
  return grouped([
    [{ id: "source", label: "open source", onClick: onOpen }],
    editorItems(`${wt.dir}/${path}`, () => sock?.send({ t: "reveal", worktreeId: wt.id, path })),
    [{ id: "copy-path", label: "copy path", onClick: () => copyText(path) }],
  ]);
}
