import { copyText, type Deps } from "../../state/actions/deps.ts";
import { editorItems } from "../../state/actions/editor.ts";
import type { MenuItem } from "../../ui/menu.ts";
import type { ToolItem } from "./group.ts";
import { callPath, relPath, toolLabel } from "./toolCall.ts";

/** what a tool row in the transcript offers: the file it named, opened elsewhere; what it ran
 * and what came back, as text; and the fold. A call on something outside the worktree has no
 * file for the editors, so it starts at the copies. */
export function toolRowItems(
  tools: ToolItem[],
  roots: string[],
  wt: { id: string; dir: string } | null,
  { sock }: Deps,
  ui: { open: boolean; toggle: () => void },
): MenuItem[] {
  const head = tools[0];
  if (!head) return [];
  const items: MenuItem[] = [];
  const rel = relPath(callPath(head), roots);
  if (rel && !rel.startsWith("/") && wt) {
    items.push(...editorItems(`${wt.dir}/${rel}`, () => sock?.send({ t: "reveal", worktreeId: wt.id, path: rel })));
  }
  const command = toolLabel(head, roots).command;
  if (command) items.push({ id: "copy-command", label: "copy command", onClick: () => copyText(command) });
  const output = tools
    .map((t) => t.output ?? "")
    .filter(Boolean)
    .join("\n");
  if (output) items.push({ id: "copy-output", label: "copy output", onClick: () => copyText(output) });
  items.push({ id: "fold", label: ui.open ? "collapse" : "expand", onClick: ui.toggle });
  return items;
}
