// What counts as "this turn changed something the preview should reload for". Two signals, one
// question, because transcripts written before the ACP adapter carry Claude tool names only:
//
// EDIT_KINDS — the ACP tool kind on tool-start. Bash-like "execute" is here on purpose: `bun add`,
//   migrations and codegen change the app without an edit tool.
// EDIT_TOOLS — the fallback for events without a kind: the Claude tool names, Bash included.

import type { ToolKind } from "./protocol/events.ts";

export const EDIT_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["edit", "delete", "move", "execute"]);
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

/** did this tool-start touch the app? */
export function isEditTool(ev: { name: string; kind?: ToolKind }): boolean {
  return ev.kind ? EDIT_KINDS.has(ev.kind) : EDIT_TOOLS.has(ev.name);
}
