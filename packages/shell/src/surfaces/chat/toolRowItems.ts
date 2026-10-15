import { copyText, type Deps } from "../../state/actions/deps.ts";
import { daemonHost, revealItems } from "../../state/actions/editor.ts";
import { openFile } from "../../state/actions/file.ts";
import { openByPath } from "../../state/openOutside.ts";
import { type EditorView, readingView } from "../../state/store.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { ToolItem } from "./group.ts";
import { callDescription, callPath, relPath, toolLabel } from "./toolCall.ts";

/** one reading of a tool row's file in the editor pane: its diff, the file, or the file rendered
 * (markdown and html). */
export interface ToolRowOpen {
  /** the menu's word for it */
  label: string;
  /** the button's sentence */
  tip: string;
  open: () => void;
}

const TIPS: Record<EditorView, string> = {
  diff: "Open this file's diff in the editor pane",
  file: "Open this file in the editor pane",
  preview: "Read this file rendered in the editor pane",
};

/** the readings the file a tool row names has, the one the row's button opens first: rendered
 * for a file that renders (a markdown mock is written to be read, not diffed), else the diff for
 * an edit, else the file (a read or a search has nothing to diff). The menu lists them all in
 * this order, as a file's menu does everywhere else in the shell, so the button is always the
 * menu's first item. Empty for a row that named no file or a worktree that is gone. A file
 * outside the worktree (a mock under /tmp) is asked for by its place on the daemon's disk, which
 * decides the reading, so it has one entry. */
export function toolRowOpens(tools: ToolItem[], roots: string[], wt: { id: string } | null, deps: Deps): ToolRowOpen[] {
  const head = tools[0];
  if (!head || !wt) return [];
  const rel = relPath(callPath(head), roots);
  if (!rel) return [];
  if (rel.startsWith("/")) {
    return [{ label: "open", tip: TIPS.file, open: () => openByPath(deps, wt.id, { href: rel, path: rel }) }];
  }
  const views: EditorView[] = [
    ...(readingView(rel) === "preview" ? (["preview"] as const) : []),
    ...(head.toolKind === "edit" ? (["diff"] as const) : []),
    "file",
  ];
  return views.map((view) => ({
    label: `open ${view}`,
    tip: TIPS[view],
    open: () => openFile(deps, { worktreeId: wt.id, path: rel, view }),
  }));
}

/** the reading the row's button opens */
export const toolRowOpen = (...args: Parameters<typeof toolRowOpens>): ToolRowOpen | null =>
  toolRowOpens(...args)[0] ?? null;

/** what a tool row in the transcript offers: the file it named, in the editor pane and in Finder;
 * what it said it was doing, what it ran and what came back, as text; and the fold. The pane and
 * the fold are different verbs: the fold shows the row's own receipt inline, the pane shows the
 * whole file below the preview. A call on a file outside the worktree (a mock under /tmp) is
 * opened by its place on the daemon's disk, read rendered as any file is, and revealed the same
 * way; a call that named no file starts at the copies. */
export function toolRowItems(
  tools: ToolItem[],
  roots: string[],
  wt: { id: string } | null,
  deps: Deps,
  ui: { open: boolean; leaf: boolean; toggle: () => void },
): MenuEntry[] {
  const { sock } = deps;
  const head = tools[0];
  if (!head) return [];
  const open: MenuItem[] = [];
  const rel = relPath(callPath(head), roots);
  const opens = toolRowOpens(tools, roots, wt, deps).map((o) => ({
    id: o.label.replace(" ", "-"),
    label: o.label,
    onClick: o.open,
  }));
  if (rel && !rel.startsWith("/") && wt) {
    open.push(
      ...opens,
      ...revealItems(() => sock?.send({ t: "reveal", worktreeId: wt.id, path: rel }), daemonHost(sock)),
    );
  } else if (rel.startsWith("/")) {
    open.push(...opens, ...revealItems(() => sock?.send({ t: "reveal-path", path: rel }), daemonHost(sock)), {
      id: "copy-path",
      label: "copy path",
      onClick: () => copyText(rel),
    });
  }
  const copies: MenuItem[] = [];
  const command = toolLabel(head, roots).command;
  // the row's line is cut at the edge and has no other copy; a description that is the command
  // itself is the command's item
  const description = callDescription(head);
  if (description && description !== command) {
    copies.push({ id: "copy-description", label: "copy description", onClick: () => copyText(description) });
  }
  if (command) copies.push({ id: "copy-command", label: "copy command", onClick: () => copyText(command) });
  const output = tools
    .map((t) => t.output ?? "")
    .filter(Boolean)
    .join("\n");
  if (output) copies.push({ id: "copy-output", label: "copy output", onClick: () => copyText(output) });
  // a row with nothing under its line has nothing to expand
  const fold: MenuItem[] = ui.leaf ? [] : [{ id: "fold", label: ui.open ? "collapse" : "expand", onClick: ui.toggle }];
  return grouped([open, copies, fold]);
}
