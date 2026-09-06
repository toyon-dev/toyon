// Which agent tools count as "writing files". Two consumers, two questions:
//
// WRITE_TOOLS — the daemon's PreToolUse hook confines these to the worktree. Bash is not here:
//   its writes are confined by the OS sandbox instead.
// EDIT_TOOLS  — the shell's "did this turn change anything the preview should reload for"
//   heuristic. Bash IS here: `bun add`, migrations and codegen change the app without Edit/Write.
//
// Before this file the two lists lived in scope.ts and store.ts and had already drifted.

export const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const EDIT_TOOLS: ReadonlySet<string> = new Set([...WRITE_TOOLS, "Bash"]);
