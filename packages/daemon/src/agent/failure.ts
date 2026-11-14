// A failure read back off the transcript. The row of a command that failed holds the command its
// start named and the output its end kept, so nothing that speaks of a failure later (a press on
// the row, the message Toyon sends for it, the paragraph behind a message that goes first) keeps
// a copy of what was printed: each rebuilds it from the row.

import type { Failed, Fixable } from "@toyon/shared";
import { unformatOutput } from "./output.ts";
import type { FailedRun, Failure, OwnFailure } from "./prompt.ts";
import type { TranscriptEntry } from "./transcript.ts";

/** a finished row as a failed run, with the daemon's mark on it when it has one; null for a row
 * that is not there, has not ended, or names no command */
function rowRun(entries: readonly TranscriptEntry[], toolId: string): { run: FailedRun; fixable?: Fixable } | null {
  let command: string | undefined;
  for (const { event } of entries) {
    if (event.type === "tool-start" && event.toolId === toolId) {
      const input = event.input as { command?: unknown } | null;
      command = typeof input?.command === "string" ? input.command : undefined;
    } else if (event.type === "tool-end" && event.toolId === toolId) {
      if (command === undefined) return null;
      const run: FailedRun = { toolId, command, text: unformatOutput(event.output ?? "") };
      return { run, ...(event.fixable ? { fixable: event.fixable } : {}) };
    }
  }
  return null;
}

/** The failure a fixable row stands for, which is what a press on it sends. Null for a row the
 * daemon never marked: the mark is the daemon's own word, and a row's name is not. */
export function rowFailure(entries: readonly TranscriptEntry[], toolId: string): Failure | null {
  const row = rowRun(entries, toolId);
  if (!row?.fixable) return null;
  if (row.fixable.kind === "hook") return { kind: "hook", hook: row.fixable.hook ?? "git", ...row.run };
  return { kind: row.fixable.kind, ...row.run };
}

/** The failure a `failure` record stands for, with what its row printed. Null for a check or a
 * hook whose row is gone, which leaves nothing to show the agent; a conflict stands without one,
 * since the step that stopped is only shown when it ran. */
export function recordedFailure(entries: readonly TranscriptEntry[], failed: Failed): OwnFailure | null {
  const run = failed.toolId ? rowRun(entries, failed.toolId)?.run : undefined;
  if (failed.kind === "conflict") {
    return {
      kind: "conflict",
      base: failed.base,
      how: failed.how,
      ...(run ? { step: run } : {}),
      ...(failed.carried ? { carried: failed.carried } : {}),
    };
  }
  if (!run) return null;
  return failed.kind === "hook" ? { kind: "hook", hook: failed.hook, ...run } : { kind: "check", ...run };
}
