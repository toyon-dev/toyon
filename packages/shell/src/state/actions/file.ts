import { grouped, type MenuEntry } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";

/** a file in the changes panel: open it somewhere, and for an uncommitted one, throw it away */
export function fileItems(
  wt: { id: string; dir: string },
  path: string,
  canDiscard: boolean,
  { sock }: Deps,
): MenuEntry[] {
  const open = editorItems(`${wt.dir}/${path}`, () => sock?.send({ t: "reveal", worktreeId: wt.id, path }));
  const discard = canDiscard
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
  return grouped([open, discard]);
}
