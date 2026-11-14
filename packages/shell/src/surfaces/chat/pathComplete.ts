// A path typed into the draft, completed against the machine's disk: the listing the project
// picker completes its own query from, read here for the word under the caret. Pure, like
// mentions.ts, so the rules have tests.

import type { PathEntry } from "@toyon/shared";
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
 * row that would complete the word to itself is left out: the path is already written. */
export function pathRows(query: string, answer: PathAnswer | null, shell: boolean): PathRow[] {
  if (!answer) return [];
  const [typedDir] = split(query);
  const [dir, name] = split(unescapePath(query));
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
