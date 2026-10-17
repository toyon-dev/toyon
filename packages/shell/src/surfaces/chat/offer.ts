// What the strip at the top of the composer offers about the chat itself: a failure Toyon did not
// act on, or a turn that was stopped or that failed, waiting for a press. Pure, like shellMode.ts,
// so the rules have tests; the one piece of state is which offers were turned down, kept for the
// page's life as the clipboard's offer is.

import { useSyncExternalStore } from "react";
import type { ChatItem } from "../../state/store.ts";
import { commandOf } from "./shellMode.ts";

/** One thing the strip can offer, named by the word that is pressed. `key` is what a dismissal
 * is remembered by: the row's own id, or the stop's place in the transcript. */
export type Offer =
  | { verb: "fix"; key: string; toolId: string; command: string }
  /** the agent's last turn was stopped by a press, or ended on an error: the word sends it on.
   * `again`: the error is the one the last press was sent after, word for word, so the press
   * already failed this way once (a usage limit until it resets) */
  | { verb: "continue"; key: string; after: "stop" | "error"; again?: true }
  | null;

/** where the box stands as the offer is read */
export interface OfferStanding {
  /** messages waiting for their turn */
  queued: number;
  /** a message is on its way out */
  sending: boolean;
  /** a question has the box, or is set aside at the top of it */
  card: boolean;
  /** the offers turned down, by key */
  dismissed: ReadonlySet<string>;
}

/** The offer the chat stands on, or null. Only the last thing in the chat is offered: a failed
 * command the daemon marked fixable, finished, that no message of Toyon's own was sent about; or
 * the stop or the error the agent's last turn ended on. So a later pass, a reply or any other row
 * retires it with no rule of its own, and so does the ask itself, which lands after the row.
 * Nothing while a message is queued or going out or a question is up: the box is about that, and
 * a question the stop closed is offered its answer instead, which is the way on from it. */
export function offerOf(chat: readonly ChatItem[], at: OfferStanding): Offer {
  if (at.queued > 0 || at.sending || at.card) return null;
  const last = chat.at(-1);
  if (!last) return null;
  if (last.kind === "stopped" || last.kind === "error") {
    // a line the daemon answered a press with has no seq: it is not the turn's end
    if (last.seq === undefined) return null;
    const key = `${last.kind}:${last.seq}`;
    if (at.dismissed.has(key)) return null;
    if (last.kind === "stopped") return { verb: "continue", key, after: "stop" };
    return { verb: "continue", key, after: "error", ...(repeats(chat) ? { again: true as const } : {}) };
  }
  if (last.kind !== "tool" || !last.done || !last.fixable || at.dismissed.has(last.id)) return null;
  if (chat.some((i) => i.kind === "asked" && i.toolId === last.id)) return null;
  const command = commandOf(last);
  return command === null ? null : { verb: "fix", key: last.id, toolId: last.id, command };
}

/** The error the chat ends on came straight after a press that went on after the same error: the
 * ask between them is the press, and nothing else happened. A turn that got as far as a word of
 * its own before failing is not a repeat, whatever the error says. */
function repeats(chat: readonly ChatItem[]): boolean {
  const [before, ask, last] = chat.slice(-3);
  return (
    last?.kind === "error" &&
    ask?.kind === "asked" &&
    ask.about === "failed" &&
    before?.kind === "error" &&
    before.text === last.text
  );
}

let dismissed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** the offer with this key was turned down: it is not made again while the page lives */
export function dismissOffer(key: string) {
  dismissed = new Set(dismissed).add(key);
  for (const l of listeners) l();
}

/** the offers turned down, by key */
export function useDismissedOffers(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => dismissed);
}
