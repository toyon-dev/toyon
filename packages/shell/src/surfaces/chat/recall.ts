// Up and down in a blank composer walk back through what was sent from it: messages and `!`
// commands in one list, newest first, the way a shell keeps one history. Pure, like shellMode.ts,
// so the rules have tests; Composer.tsx hands the keys here and ChatLog.tsx marks the row.

import type { ChatItem, ComposerWalk } from "../../state/store.ts";
import { commandOf } from "./shellMode.ts";

/** one thing sent from the box, written the way the box would hold it again, and its index in the chat */
export type Sent = { text: string; at: number };

/** what an arrow does to the box: the draft to show, and where the walk now is (null once it is over) */
export type Step = { walk: ComposerWalk | null; text: string };

/** a box with nothing typed in it: empty, or holding only the `!` that opens a command */
export const isBlank = (text: string) => text === "" || text === "!";

/** what the walk steps through, newest first, each text once. From a bare `!` only the commands:
 * the sigil already said which kind of thing is wanted. */
export function sentHistory(chat: ChatItem[], commandsOnly: boolean): Sent[] {
  const seen = new Set<string>();
  const out: Sent[] = [];
  for (let at = chat.length - 1; at >= 0; at--) {
    const item = chat[at]!;
    const command = commandOf(item);
    const text = command !== null ? `!${command}` : item.kind === "user" && !commandsOnly ? item.text : null;
    if (text === null || !text.trim() || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, at });
  }
  return out;
}

/** Up or down in the composer, or null when the key is not the walk's to take: in a box with
 * something typed in it an arrow moves the caret, as it does in any text box. `walk` is null while
 * the draft is the person's own. */
export function stepWalk(chat: ChatItem[], walk: ComposerWalk | null, text: string, key: "up" | "down"): Step | null {
  if (!walk) {
    if (key !== "up" || !isBlank(text)) return null;
    const newest = sentHistory(chat, text === "!")[0];
    return newest ? { walk: { at: newest.at, from: text }, text: newest.text } : null;
  }
  // found by its place in the chat rather than kept as a position in this list, so a message that
  // lands mid-walk does not slide the walk onto a different entry
  const list = sentHistory(chat, walk.from === "!");
  const next = list.findIndex((s) => s.at === walk.at) + (key === "up" ? 1 : -1);
  if (next < 0) return { walk: null, text: walk.from };
  const entry = list[next];
  // past the oldest the key is still the walk's, and nothing moves
  if (!entry) return { walk, text };
  return { walk: { at: entry.at, from: walk.from }, text: entry.text };
}
