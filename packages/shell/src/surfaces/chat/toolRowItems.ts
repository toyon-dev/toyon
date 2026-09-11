import { copyText, type Deps } from "../../state/actions/deps.ts";
import { editorItems } from "../../state/actions/editor.ts";
import { openFile } from "../../state/actions/file.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { ToolItem } from "./group.ts";
import { callPath, relPath, toolLabel } from "./toolCall.ts";

/** what a tool row in the transcript offers: the file it named, in the diff pane and elsewhere;
 * what it ran and what came back, as text; and the fold. The pane and the fold are different
 * verbs: the fold shows the row's own receipt inline, the pane shows the whole file below the
 * preview. A call on something outside the worktree has no file, so it starts at the copies. */
export function toolRowItems(
  tools: ToolItem[],
  roots: string[],
  wt: { id: string; dir: string } | null,
  deps: Deps,
  ui: { open: boolean; toggle: () => void },
): MenuEntry[] {
  const { sock } = deps;
  const head = tools[0];
  if (!head) return [];
  const open: MenuItem[] = [];
  const rel = relPath(callPath(head), roots);
  if (rel && !rel.startsWith("/") && wt) {
    // a read or a search has nothing to diff, so the pane is just the file for those
    const view = head.toolKind === "edit" ? "diff" : "file";
    open.push({
      id: "open-diff",
      label: `open ${view}`,
      onClick: () => openFile(deps, { worktreeId: wt.id, path: rel, view }),
    });
    open.push(...editorItems(`${wt.dir}/${rel}`, () => sock?.send({ t: "reveal", worktreeId: wt.id, path: rel })));
  }
  const copies: MenuItem[] = [];
  const command = toolLabel(head, roots).command;
  if (command) copies.push({ id: "copy-command", label: "copy command", onClick: () => copyText(command) });
  const output = tools
    .map((t) => t.output ?? "")
    .filter(Boolean)
    .join("\n");
  if (output) copies.push({ id: "copy-output", label: "copy output", onClick: () => copyText(output) });
  const fold: MenuItem[] = [{ id: "fold", label: ui.open ? "collapse" : "expand", onClick: ui.toggle }];
  return grouped([open, copies, fold]);
}
