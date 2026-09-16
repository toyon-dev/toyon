// The composer's `!` mode: a draft that leads with `!` is a command for the worktree's shell rather
// than a message for the agent. Pure, like mentions.ts, so the rules have tests.

import { CHECK_TOOL, SHELL_TOOL } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import { parseToolOutput } from "./toolCall.ts";

/** the command a draft asks to run, or null for a draft that is a message. A sigil rather than a
 * guess at the first word: "make the button bigger" and "find the bug" both open with a command,
 * and a box that sometimes ran your prose would never be trusted again. `!` at column zero is
 * what Claude Code uses, and it is the one character prose almost never opens with. */
export function shellCommandOf(text: string): string | null {
  if (!text.startsWith("!")) return null;
  return text.slice(1).trim();
}

/** the command a row of the transcript ran from the composer, or the repo's check toyon ran after
 * a turn; null for anything else, the agent's own shell calls included */
export function commandOf(item: ChatItem): string | null {
  if (item.kind !== "tool" || (item.name !== SHELL_TOOL && item.name !== CHECK_TOOL)) return null;
  const input = item.input as { command?: unknown } | null;
  return typeof input?.command === "string" ? input.command : null;
}

/** how much of one command's output the agent is shown: enough for a log or a listing, not a
 * whole file the agent could read for itself */
const CONTEXT_CHARS = 6_000;

/** the commands run since the person's last message, with what they printed, for the agent to
 * read with the next one: `!git log` followed by "why did this break" is the point of the mode.
 * Nothing older: that was answered already, or belongs to a question that has moved on. */
export function shellContext(chat: ChatItem[]): string | undefined {
  const runs: string[] = [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const item = chat[i]!;
    if (item.kind === "user") break;
    if (item.kind !== "tool" || !item.done) continue;
    const command = commandOf(item);
    if (command === null) continue;
    const text = parseToolOutput(item.output ?? "")
      .map((b) => b.text)
      .join("\n");
    const shown = text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS)}\n[output cut here]` : text;
    runs.unshift(`$ ${command}${shown ? `\n${shown}` : ""}`);
  }
  if (runs.length === 0) return undefined;
  return `Shell commands the user ran since their last message, and what each printed:\n${runs.join("\n")}`;
}
