// What a proposing tool shares with the verbs: a pieces list is a card an agent raises on its own
// chat for the person to answer, so one turn has an allowance of them, and targets are named by a
// ladder of looser and looser matches.

import type { TranscriptEntry } from "../agent/transcript.ts";

/** cards one turn may raise, answered or not: a loop ends here */
export const PER_TURN_MAX = 3;

/** How many cards of its own the turn under way has put before the person, declined ones
 * included: a list proposed outside plan mode, or a held one shown since. A list held for a plan
 * card costs nothing: it rides a card the person answers, and a plan redrafted around their
 * answers or sent back for changes needs a new list each round, however long the turn runs. */
export function proposedThisTurn(entries: readonly TranscriptEntry[]): number {
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "turn-start") break;
    if (e.type === "handoff-shown" || (e.type === "handoff-proposed" && !e.held)) n++;
  }
  return n;
}

/** the items `q` names, by the first rung of the ladder that any item passes: an exact key first,
 * then the same in any case, then a unique prefix. A rung passed by several items is ambiguous,
 * which the caller says in its own words. */
export function matchBy<T>(items: readonly T[], q: string, keys: Array<(item: T) => string | undefined>): T[] {
  // nothing named is nothing found: a blank would otherwise be a prefix of every name
  if (!q.trim()) return [];
  const lower = q.toLowerCase();
  const rungs: Array<(v: string) => boolean> = [
    (v) => v === q,
    (v) => v.toLowerCase() === lower,
    (v) => v.toLowerCase().startsWith(lower),
  ];
  for (const rung of rungs) {
    const found = items.filter((item) => keys.some((key) => rung(key(item) ?? "")));
    if (found.length > 0) return found;
  }
  return [];
}
