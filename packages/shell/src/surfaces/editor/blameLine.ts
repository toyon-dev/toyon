// The ghost after the caret's line: who last touched it, how long ago, and what that commit said.

import type { FileBlame } from "@toyon/shared";
import { ago } from "../util.ts";

/** One line of blame as the ghost reads it. Null for a line the blame does not reach (a file git
 * cannot blame, or a line past its end) and "not committed yet" for one only the working tree has. */
export function blameLine(blame: FileBlame, line: number): string | null {
  const idx = blame.lines[line - 1];
  if (idx === undefined) return null;
  if (idx < 0) return "not committed yet";
  const c = blame.commits[idx];
  if (!c) return null;
  // a commit with no author named is still a commit: its sha stands in
  const parts = [c.author || c.sha.slice(0, 7), ago(c.at)];
  if (c.subject) parts.push(c.subject);
  return parts.join(" · ");
}
