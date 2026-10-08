// The logic behind the handoff card in the composer, kept out of the component so it has tests
// without a DOM. A handoff is a proposal to continue the work in another open project: the card
// shares the box with the agent's asks, and this is what decides which card the box shows, what
// its line says once parked, and what the typed `/handoff` means.

import { type ClientMsg, cardBox, type RepoInfo } from "@toyon/shared";
import type { ChatItem, WorktreeLocal } from "../../state/store.ts";
import { type AskItem, askLine } from "./ask.ts";

export type HandoffItem = Extract<ChatItem, { kind: "handoff" }>;

/** what can hold the composer box: an open ask, or a handoff still proposed */
export type CardItem = AskItem | HandoffItem;

/** the card the box shows: the newest one nothing has closed, or none */
export function openCard(chat: ChatItem[]): CardItem | null {
  const item = chat.findLast(
    (i) => (i.kind === "ask" && !i.outcome) || (i.kind === "handoff" && i.state === "proposed"),
  );
  return item?.kind === "ask" || item?.kind === "handoff" ? item : null;
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
 * handoff card asks */
export function cardLine(card: CardItem): string {
  return card.kind === "ask" ? askLine(card) : `Continue in ${card.repo.name}?`;
}

/** the answer to the card: `note` rides with go alone, trimmed, and a blank one is left off */
export function handoffAnswer(
  item: HandoffItem,
  worktreeId: string,
  go: boolean,
  note: string | undefined,
): Extract<ClientMsg, { t: "handoff-answer" }> {
  const said = go ? note?.trim() : undefined;
  return { t: "handoff-answer", worktreeId, id: item.id, go, ...(said ? { note: said } : {}) };
}

/** what `/handoff <project> [text]` means: the project to continue in and the person's own words,
 * the picker when nothing was named, or why the name does not pick one */
export type HandoffArgs = { repo: RepoInfo; text?: string } | { error: string } | { pick: true };

/** The first word names the project, by its name as listed: an exact match first (case does not
 * matter), else the one project whose name starts with it. The rest is the person's own words for
 * what that project should do. */
export function parseHandoffArgs(args: string, repos: readonly RepoInfo[], hereRepoId: string): HandoffArgs {
  const trimmed = args.trim();
  if (!trimmed) return { pick: true };
  if (repos.length < 2) return { error: "open another project first" };
  const gap = trimmed.search(/\s/);
  const word = gap === -1 ? trimmed : trimmed.slice(0, gap);
  // the words as typed: the message is theirs, and its spacing is not this parser's to tidy
  const text = gap === -1 ? undefined : trimmed.slice(gap).trim() || undefined;
  const needle = word.toLowerCase();
  const exact = repos.filter((r) => r.name.toLowerCase() === needle);
  const hits = exact.length > 0 ? exact : repos.filter((r) => r.name.toLowerCase().startsWith(needle));
  if (hits.length === 0) return { error: `no open project named "${word}"` };
  if (hits.length > 1) return { error: `"${word}" names more than one project` };
  const repo = hits[0]!;
  if (repo.id === hereRepoId) return { error: `this worktree is already in ${repo.name}` };
  return { repo, ...(text ? { text } : {}) };
}
