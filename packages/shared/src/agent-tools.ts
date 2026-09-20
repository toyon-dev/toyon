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

// The narrower question a recap asks: did it write a file? A shell command can change the app
// without being an edit anyone would count, so `execute` and Bash are left out here.
export const WRITE_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["edit", "delete", "move"]);
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function isWriteTool(ev: { name: string; kind?: ToolKind }): boolean {
  return ev.kind ? WRITE_KINDS.has(ev.kind) : WRITE_TOOLS.has(ev.name);
}

// A call whose input the agent writes out token by token: its row exists before the path or
// command it names has arrived, and until then the call is being written, not run. A think or a
// mode switch has nothing to write, so an empty input there is the whole call. A tuple, so the
// phrase the shell prints per kind is typed over exactly this set.
export const WRITTEN_KINDS = ["read", "edit", "delete", "move", "search", "execute", "fetch"] as const;
export type WrittenKind = (typeof WRITTEN_KINDS)[number];

export function isWrittenKind(kind: string | undefined): kind is WrittenKind {
  return (WRITTEN_KINDS as readonly string[]).includes(kind ?? "");
}

/** no input yet: nothing, or the empty list of locations a call with no raw input starts as */
export function emptyInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return true;
  const rec = input as Record<string, unknown>;
  return Object.keys(rec).every((k) => k === "locations" && Array.isArray(rec[k]) && rec[k].length === 0);
}
