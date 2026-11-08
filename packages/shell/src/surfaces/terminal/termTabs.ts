// The streams a worktree's terminal pane lists, as data: its own procs, the shared ones it reaches
// on main, and the ones its page points at a remote. Pure, so the order and the words are tested
// without the pane; useTermTabs draws them.

import type { Borrowed, ProcState, ProcStatus } from "@toyon/shared";
import { dirtyNote } from "../chips/baseNote.ts";
import { procLabel } from "../util.ts";

export type StreamTab =
  | { kind: "proc"; proc: ProcState }
  | { kind: "borrowed"; name: string; dot: ProcStatus | "borrowed"; tip: string }
  | { kind: "pointed"; name: string; remote: string; tip: string };

/** the words for a borrowed proc's tab: where it runs, and what main's state of it means here */
export function borrowedTip(b: Borrowed, dirty: number): string {
  const parts = [`${b.name} runs on main for every worktree; this one reaches it at its usual address.`];
  if (dirty > 0) parts.push(`${dirtyNote(dirty, b.name)[0]!.toUpperCase()}${dirtyNote(dirty, b.name).slice(1)}.`);
  if (b.status !== "running" && b.status !== "starting" && b.status !== "cold") {
    parts.push(`Main's ${b.name} is ${procLabel(b.status).toLowerCase()}.`);
  }
  return parts.join(" ");
}

/** the proc tabs after the shell and the login: this worktree's own in config order, then what it
 * borrows, then what it points away. A borrowed proc up on main wears the ring dot (present by
 * reference); one that is down there wears main's status. */
export function streamTabs({
  procs,
  borrowed,
  pointed,
  dirty,
}: {
  procs: ProcState[];
  borrowed: Borrowed[];
  pointed: Record<string, string>;
  /** main's uncommitted file count */
  dirty: number;
}): StreamTab[] {
  const up = (s: ProcStatus | "cold") => s === "running" || s === "starting" || s === "cold";
  return [
    ...procs.map((proc): StreamTab => ({ kind: "proc", proc })),
    ...borrowed.map(
      (b): StreamTab => ({
        kind: "borrowed",
        name: b.name,
        dot: up(b.status) ? "borrowed" : b.status,
        tip: borrowedTip(b, dirty),
      }),
    ),
    ...Object.entries(pointed).map(
      ([name, remote]): StreamTab => ({
        kind: "pointed",
        name,
        remote,
        tip: `${name} points at ${remote} for this worktree`,
      }),
    ),
  ];
}
