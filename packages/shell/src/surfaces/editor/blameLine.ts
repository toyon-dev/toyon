// The note after the caret's line, who and when, and the commit the card over it names.

import type { BlameCommit, FileBlame } from "@toyon/shared";
import { ago } from "../util.ts";

/** The commit a line's blame names: null for a line the blame does not reach (a file git cannot
 * blame, or a line past its end) or one only the working tree has. */
export function blameCommit(blame: FileBlame, line: number): BlameCommit | null {
  const idx = blame.lines[line - 1];
  if (idx === undefined || idx < 0) return null;
  return blame.commits[idx] ?? null;
}

/** One line of blame as the note reads it: who and how long ago, and "not committed yet" for a
 * line only the working tree has. What the commit said is the card's, on hover. */
export function blameLine(blame: FileBlame, line: number): string | null {
  const idx = blame.lines[line - 1];
  if (idx === undefined) return null;
  if (idx < 0) return "not committed yet";
  const c = blame.commits[idx];
  if (!c) return null;
  // a commit with no author named is still a commit: its sha stands in
  return `${c.author || c.sha.slice(0, 7)}, ${ago(c.at)}`;
}
