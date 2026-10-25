// What the cards in the composer box share, kept out of the components so it has tests without a
// DOM: which card the box shows, where a drop on the chat goes while one holds it, and what its
// line says once it is set aside.

import { cardBox } from "@toyon/shared";
import type { ChatItem, WorktreeLocal } from "../../state/store.ts";
import { type AskItem, askLine } from "./ask.ts";
import { type PiecesItem, piecesQuestion } from "./pieces.ts";

/** what can hold the composer box: an open ask, or a pieces list that is Toyon's own card (a held
 * one rides beside a plan card and holds nothing itself) */
export type CardItem = AskItem | PiecesItem;

/** the card the box shows: the newest one nothing has closed, or none */
export function openCard(chat: ChatItem[]): CardItem | null {
  const item = chat.findLast(
    (i) => (i.kind === "ask" && !i.outcome) || (i.kind === "pieces" && i.state === "proposed"),
  );
  return item?.kind === "ask" || item?.kind === "pieces" ? item : null;
}

/** the box a drop on the chat goes to when a question card has the box: the card's own, since the
 * drop goes with the answer and not with the message written behind the card. Null when the
 * composer's field is what is on screen: no card, a card set aside, or one of another kind. */
export function cardDropBox(l: Pick<WorktreeLocal, "chat" | "cardParked"> | undefined): string | null {
  const card = l ? openCard(l.chat) : null;
  if (card?.kind !== "ask" || card.ask.kind !== "question" || l?.cardParked === card.id) return null;
  return cardBox(card.id);
}

/** the line that stands for the card once it is set aside: the ask's own, or the question the
 * pieces card asks */
export function cardLine(card: CardItem): string {
  return card.kind === "ask" ? askLine(card) : piecesQuestion(card);
}
