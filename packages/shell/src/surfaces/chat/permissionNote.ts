// What a permission card does with words: which row a letter typed on the card writes under, and
// which keys are the start of writing rather than the list's own. Pure over the choices and the
// key's shape, so the card's keyboard is tested without a DOM.

import type { AskChoice } from "@toyon/shared";
import { isDigit, type KeyLike, shellChord } from "../../ui/choiceKeys.ts";

/** the row words land under when nothing said which: the no, since words on a plan card are
 * nearly always what to change; a card with no refusal on it takes the cursor's row */
export function rejectRow(choices: AskChoice[]): number | null {
  const i = choices.findIndex((c) => c.kind.startsWith("reject"));
  return i < 0 ? null : i;
}

/** a key that starts writing on the card: one printable character with no chord on it. The
 * digits are picks, `n` is the row's own key, a space picks nothing and starts nothing. */
export function typingStart(e: KeyLike): string | null {
  const { key } = e;
  if (key.length !== 1 || key === " " || key === "n" || isDigit(key) || shellChord(e)) return null;
  return key;
}
