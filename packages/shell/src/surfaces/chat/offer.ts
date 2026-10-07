// What the strip at the top of the composer offers about the chat itself: a failure Toyon did not
// act on, waiting for a press. Pure, like shellMode.ts, so the rules have tests; the one piece of
// state is which offers were turned down, kept for the page's life as the clipboard's offer is.

import { useSyncExternalStore } from "react";
import type { ChatItem } from "../../state/store.ts";
import { commandOf } from "./shellMode.ts";

/** one thing the strip can offer, named by the word that is pressed */
export type Offer = { verb: "fix"; toolId: string; command: string } | null;

/** where the box stands as the offer is read */
export interface OfferStanding {
  /** messages waiting for their turn */
  queued: number;
  /** a message is on its way out */
  sending: boolean;
  /** a question has the box, or is set aside at the top of it */
  card: boolean;
  /** the rows whose offer was turned down */
  dismissed: ReadonlySet<string>;
}

/** The offer the chat stands on, or null. Only the last thing in the chat is offered: a failed
 * command the daemon marked fixable, finished, that no message of Toyon's own was sent about. So
 * a later pass, a reply or any other row retires it with no rule of its own, and so does the ask
 * itself, which lands after the row. Nothing while a message is queued or going out or a question
 * is up: the box is about that. */
export function offerOf(chat: readonly ChatItem[], at: OfferStanding): Offer {
  if (at.queued > 0 || at.sending || at.card) return null;
  const last = chat.at(-1);
  if (last?.kind !== "tool" || !last.done || !last.fixable || at.dismissed.has(last.id)) return null;
  if (chat.some((i) => i.kind === "asked" && i.toolId === last.id)) return null;
  const command = commandOf(last);
  return command === null ? null : { verb: "fix", toolId: last.id, command };
}

let dismissed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** the offer on this row was turned down: it is not made again while the page lives */
export function dismissOffer(toolId: string) {
  dismissed = new Set(dismissed).add(toolId);
  for (const l of listeners) l();
}

/** the rows whose offer was turned down */
export function useDismissedOffers(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => dismissed);
}
