// What the caret is typing a trigger for, and what picking a row does to the draft. Pure so the
// rules are testable: the shell has no React harness, so anything with a rule in it lives here
// rather than in the composer.

import type { AgentCommand } from "@toyon/shared";
import { commandScore } from "../overlays/commands.ts";
import { type DotState, folderList } from "../util.ts";

export interface Trigger {
  kind: "file" | "command";
  query: string;
  /** the span a pick replaces, sigil included */
  from: number;
  to: number;
}

/** paths type straight through; a space ends the mention, since no path we list contains one */
const IN_MENTION = /^[^\s]*$/;
/** a word past the space that is only punctuation (`@toyon/fix ?`) is the sentence going on, not
 * the title's next word: the match reads names without punctuation, so it would take it as one */
const namesOn = (query: string) =>
  query
    .split(/\s+/)
    .slice(1)
    .every((w) => !w || /[a-z0-9]/i.test(w));

/** `continues` says whether a query with spaces in it still names something, which only a
 * worktree title can: the menu stays open past a space while it does, so a title is typed as it
 * reads, and closes at the space where the words stop naming one, as they do for a path. */
export function triggerAt(text: string, caret: number, continues?: (query: string) => boolean): Trigger | null {
  // a `!` draft is a command for the shell (shellMode.ts): no menu, since an `@path` picked into
  // one would hand the shell a literal `@`, and a slash in a command is a path
  if (text.startsWith("!")) return null;
  // A slash command only counts at the very start of the draft, because that is the only place an
  // agent will dispatch one: offering it mid-text would insert something that silently runs as
  // prose. Everything up to the first space is the command name.
  if (text.startsWith("/")) {
    const end = text.indexOf(" ");
    const nameEnd = end === -1 ? text.length : end;
    // a second slash makes it a path (`/Users/me/app.ts`), and no command is named with one
    const isPath = text.indexOf("/", 1) !== -1 && text.indexOf("/", 1) < nameEnd;
    if (!isPath && caret <= nameEnd) return { kind: "command", query: text.slice(1, caret), from: 0, to: nameEnd };
  }
  const at = text.lastIndexOf("@", Math.max(0, caret - 1));
  if (at === -1 || at >= caret) return null;
  // an address or a decorator is not a mention: the sigil has to open a word
  if (at > 0 && !/\s/.test(text[at - 1] ?? "")) return null;
  const query = text.slice(at + 1, caret);
  // a space in the query is allowed only while the words still name a worktree; a trailing
  // space is the title's next word about to be typed, and holds too
  if (!IN_MENTION.test(query) && !(namesOn(query) && continues?.(query))) return null;
  let to = caret;
  while (to < text.length && !/\s/.test(text[to] ?? "")) to++;
  return { kind: "file", query, from: at, to };
}

/** what a message's `@` references resolve against: the worktree's files, and the folders they
 * imply, which is the same list the `@` menu offers, so a reference is a link exactly when the
 * menu would have offered it */
export interface MentionIndex {
  files: ReadonlySet<string>;
  folders: ReadonlySet<string>;
  /** the project's other open worktrees by branch: what `@toyon/foo` names when no file does */
  worktrees: ReadonlyMap<string, WorktreeMention>;
}

/** a worktree a message can name: its row, and the title the mark says; one in the archive opens
 * as its page, so a reference written while it was open keeps its mark after it goes */
export interface WorktreeMention {
  id: string;
  title: string;
  archived?: true;
  /** what the rail's row says of a live one, for the mark's tip: its dot, the dot in words, and
   * when it was last sent to. An archived row has none. */
  dot?: DotState;
  state?: string;
  at?: number;
}

const NO_WORKTREES: ReadonlyMap<string, WorktreeMention> = new Map();
const NO_INDEX: MentionIndex = { files: new Set(), folders: new Set(), worktrees: NO_WORKTREES };

// one index per file list: every bubble of a transcript reads the same list, and the folder walk
// over a large checkout is not a thing to redo per row
const indexes = new WeakMap<readonly string[], MentionIndex>();

/** the index for a file list; without one, only `@changes` and the worktrees resolve */
export function mentionIndex(
  files: readonly string[] | undefined,
  worktrees: ReadonlyMap<string, WorktreeMention> = NO_WORKTREES,
): MentionIndex {
  if (!files) return worktrees === NO_WORKTREES ? NO_INDEX : { ...NO_INDEX, worktrees };
  let index = indexes.get(files);
  if (!index) {
    index = { files: new Set(files), folders: new Set(folderList(files)), worktrees: NO_WORKTREES };
    indexes.set(files, index);
  }
  return worktrees === NO_WORKTREES ? index : { ...index, worktrees };
}

export type MentionSpan =
  | { kind: "text"; text: string }
  | { kind: "file"; text: string; path: string }
  | { kind: "folder"; text: string; path: string }
  | { kind: "changes"; text: string }
  | ({ kind: "worktree"; text: string } & WorktreeMention);

/** the sigil opens a word, as it must for the menu (`triggerAt`), and the word runs to the next space */
const MENTION = /(^|\s)(@\S+)/g;
/** what a sentence hangs on the end of a reference: `see @src/App.tsx.` names the file, not `App.tsx.` */
const TRAILING = /[.,;:!?)\]}'"]$/;

function resolve(word: string, index: MentionIndex): MentionSpan | null {
  if (word === "changes") return { kind: "changes", text: "@changes" };
  if (index.files.has(word)) return { kind: "file", text: `@${word}`, path: word };
  const folder = word.replace(/\/+$/, "");
  if (folder && index.folders.has(folder)) return { kind: "folder", text: `@${word}`, path: folder };
  // a file wins over a branch of the same name: the path is what the agent reads first
  const wt = index.worktrees.get(word);
  if (wt) return { kind: "worktree", text: `@${word}`, ...wt };
  return null;
}

/** Whether the `@` menu has anything left to say over the word being typed: it has one row, and
 * the word is already what that row would write (its trailing space aside). The mark under the
 * word says the same thing, and a menu open there takes return for a pick of what is already
 * there instead of the send. Two rows are still a choice, and a title typed as words is not yet
 * the branch the pick writes. */
export function settled(query: string, insertions: readonly string[]): boolean {
  return insertions.length === 1 && insertions[0]?.trim() === `@${query}`;
}

/** a message split at every `@` reference that names something in the project: a file or folder
 * the index holds, the uncommitted set, or another worktree by its branch. Anything else stays
 * prose, an address included, so the mark says the agent has somewhere to look rather than that
 * a sigil was typed. */
export function mentionSpans(text: string, index: MentionIndex): MentionSpan[] {
  const out: MentionSpan[] = [];
  let last = 0;
  const push = (s: string) => {
    if (!s) return;
    const prev = out.at(-1);
    if (prev?.kind === "text") prev.text += s;
    else out.push({ kind: "text", text: s });
  };
  for (const m of text.matchAll(MENTION)) {
    const start = m.index + (m[1] ?? "").length;
    let word = (m[2] ?? "").slice(1);
    let hit = resolve(word, index);
    // punctuation is peeled from the end until the reference is one the index knows
    while (!hit && TRAILING.test(word)) {
      word = word.slice(0, -1);
      hit = word ? resolve(word, index) : null;
    }
    if (!hit) continue;
    push(text.slice(last, start));
    out.push(hit);
    last = start + hit.text.length;
  }
  push(text.slice(last));
  return out;
}

/** the draft with the trigger's span replaced, and where the caret lands after it */
export function insertAt(text: string, span: { from: number; to: number }, replacement: string) {
  const next = text.slice(0, span.from) + replacement + text.slice(span.to);
  return { text: next, caret: span.from + replacement.length };
}

/**
 * The `/` rows, ranked by the same word-start rule the ⌘⇧P palette uses.
 *
 * Names first, and descriptions only when no name matches at all. Searching both at once buries
 * the command someone is typing: `/plan` matched "plan usage", "Research and plan a large-scale
 * change" and four more before anything actually called plan. The description is still worth
 * searching when the name is unguessable (`/chart` should find a skill named dataviz), so it stays
 * as a fallback rather than a competitor.
 *
 * Equal scores keep the list's own order, which is the order the rows rank in before a letter is
 * typed: the person's own, toyon's, the agent's (ownCommands.ts `mergeCommands`). So two names
 * that match alike settle by whose they are, not by the alphabet.
 */
export function filterCommands(commands: AgentCommand[], q: string): AgentCommand[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return commands;
  const ranked = (score: (c: AgentCommand) => number) =>
    commands
      .map((c, i) => ({ c, i, score: score(c) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.c);
  const byName = ranked((c) => commandScore(c.name, needle));
  return byName.length > 0 ? byName : ranked((c) => commandScore(c.description, needle));
}
