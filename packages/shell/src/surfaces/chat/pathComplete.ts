// A path typed into the draft, completed against the machine's disk: the listing the project
// picker completes its own query from, read here for the word under the caret. Pure, like
// mentions.ts, so the rules have tests.

import type { PathEntry, PathTarget } from "@toyon/shared";
import { expandHome } from "../overlays/projectPicker.ts";
import type { Trigger } from "./mentions.ts";

/** one way the typed path could go on */
export interface PathRow {
  name: string;
  /** the whole word once this row is taken, in the case the disk spells it: a folder ends in its
   * slash, so the next tab walks into it */
  completion: string;
  folder: boolean;
}

/** what the daemon last said about a path, and the path it was asked about */
export interface PathAnswer {
  query: string;
  entries: readonly PathEntry[];
}

/** A space ends a word in the draft, so a name with one is written with a backslash holding it,
 * and a backslash of the name's own is doubled to survive the reading. */
const HELD_IN_PROSE = /[ \\]/g;
/** a command goes to a shell, which reads far more than the space */
const HELD_IN_SHELL = /[ \\'"()&;|<>$`*?![\]{}#]/g;

/** a name as the draft spells it */
export const escapeName = (name: string, shell: boolean) => name.replace(shell ? HELD_IN_SHELL : HELD_IN_PROSE, "\\$&");

/** the path a word of the draft spells, its backslashes read: what the daemon is asked about */
export const unescapePath = (typed: string) => typed.replace(/\\(.)/g, "$1");

/** a path cut after its last slash: the folder being looked in, and the start of a name in it */
function split(path: string): [dir: string, leaf: string] {
  const cut = path.lastIndexOf("/") + 1;
  return [path.slice(0, cut), path.slice(cut)];
}

/** The rows for the path typed so far, from the daemon's last answer. An answer about the same
 * folder is narrowed here to the name as it stands now, so the list follows each letter instead
 * of emptying until the next answer lands; one about another folder says nothing of this one. A
 * row that would complete the word to itself is left out: the path is already written.
 *
 * `base` is the folder a path that names no root of its own is read from, slash included: a
 * command's words are paths from the worktree it runs in. */
export function pathRows(query: string, answer: PathAnswer | null, shell: boolean, base = ""): PathRow[] {
  if (!answer) return [];
  const [typedDir] = split(query);
  const [dir, name] = split(base + unescapePath(query));
  const [answeredDir, answeredName] = split(answer.query);
  const leaf = name.toLowerCase();
  const answered = answeredName.toLowerCase();
  if (!dir || answeredDir !== dir || !(leaf.startsWith(answered) || answered.startsWith(leaf))) return [];
  return answer.entries
    .filter((e) => e.name.toLowerCase().startsWith(leaf))
    .map((e) => ({
      name: e.name,
      completion: `${typedDir}${escapeName(e.name, shell)}${e.isFile ? "" : "/"}`,
      folder: !e.isFile,
    }))
    .filter((r) => r.completion !== query);
}

/** A draft that opens with one slash is a command until a second slash says otherwise, so `/Us`
 * is asked of the commands first. This is the same word read as the path it also spells, for the
 * host to fall back on when no command answers to it. */
export function commandAsPath(trigger: Trigger | null): Trigger | null {
  if (trigger?.kind !== "command" || !trigger.query || /\s/.test(trigger.query)) return null;
  return { kind: "path", query: `/${trigger.query}`, from: 0, to: trigger.to };
}

/** what the disk holds at a path, as far as any answer has said; `none` was asked about and is
 * not there, which is worth keeping so it is not asked about again */
export type PathKind = "file" | "folder" | "none";
export type PathKinds = Readonly<Record<string, PathKind>>;

/** a path as the daemon's disk names it, home written out and no slash at its end, which is the
 * one spelling the answers are kept under; null for a path that names no root */
export function diskPath(typed: string, home: string): string | null {
  const abs = expandHome(typed.trim(), home);
  if (!abs.startsWith("/")) return null;
  return abs.replace(/\/+$/, "") || "/";
}

/** What is known of the disk once an answer is in: the path asked about, and every entry listed
 * beside it. A message that names a path is marked from this, so a path the completion wrote is
 * a link the moment it is written, with nothing more asked. */
export function pathKindsWith(
  known: PathKinds,
  answer: { query: string; entries: readonly PathEntry[]; target: PathTarget },
  home: string,
): PathKinds {
  const next: Record<string, PathKind> = { ...known };
  const asked = diskPath(answer.query, home);
  if (asked) next[asked] = answer.target.isDir ? "folder" : answer.target.isFile ? "file" : "none";
  for (const e of answer.entries) {
    const at = diskPath(e.path, home);
    if (at) next[at] = e.isFile ? "file" : "folder";
  }
  return next;
}
