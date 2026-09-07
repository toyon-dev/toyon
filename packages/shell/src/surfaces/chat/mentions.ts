// What the caret is typing a trigger for, and what picking a row does to the draft. Pure so the
// rules are testable: the shell has no React harness, so anything with a rule in it lives here
// rather than in the composer.

import type { AgentCommand } from "@toyon/shared";
import { commandScore } from "../palettes/commands.ts";

export interface Trigger {
  kind: "file" | "command";
  query: string;
  /** the span a pick replaces, sigil included */
  from: number;
  to: number;
}

/** paths type straight through; a space ends the mention, since no path we list contains one */
const IN_MENTION = /^[^\s]*$/;

export function triggerAt(text: string, caret: number): Trigger | null {
  // A slash command only counts at the very start of the draft, because that is the only place an
  // agent will dispatch one: offering it mid-text would insert something that silently runs as
  // prose. Everything up to the first space is the command name.
  if (text.startsWith("/")) {
    const end = text.indexOf(" ");
    const nameEnd = end === -1 ? text.length : end;
    if (caret <= nameEnd) return { kind: "command", query: text.slice(1, caret), from: 0, to: nameEnd };
  }
  const at = text.lastIndexOf("@", Math.max(0, caret - 1));
  if (at === -1 || at >= caret) return null;
  // an address or a decorator is not a mention: the sigil has to open a word
  if (at > 0 && !/\s/.test(text[at - 1] ?? "")) return null;
  const query = text.slice(at + 1, caret);
  if (!IN_MENTION.test(query)) return null;
  let to = caret;
  while (to < text.length && !/\s/.test(text[to] ?? "")) to++;
  return { kind: "file", query, from: at, to };
}

/** the draft with the trigger's span replaced, and where the caret lands after it */
export function insertAt(text: string, span: { from: number; to: number }, replacement: string) {
  const next = text.slice(0, span.from) + replacement + text.slice(span.to);
  return { text: next, caret: span.from + replacement.length };
}

/** the `/` rows, ranked by the same word-start rule the ⌘⇧P palette uses */
export function filterCommands(commands: AgentCommand[], q: string): AgentCommand[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return commands;
  return commands
    .map((c) => ({ c, score: commandScore(`${c.name} ${c.description}`, needle) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}
