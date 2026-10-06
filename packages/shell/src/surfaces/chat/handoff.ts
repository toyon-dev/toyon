// The logic behind the handoff card in the composer, kept out of the component so it has tests
// without a DOM. A handoff is a proposal to continue the work in another open project: the card
// shares the box with the agent's asks, and this is what decides which card the box shows, what
// its line says once parked, and what the typed `/handoff` means.

import type { ClientMsg, RepoInfo } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import { type AskItem, askLine } from "./ask.ts";

export type HandoffItem = Extract<ChatItem, { kind: "handoff" }>;

/** what can hold the composer box: an open ask, or a handoff still proposed */
export type BoxCard = AskItem | HandoffItem;

/** the card the box shows: the newest one nothing has closed, or none */
export function openCard(chat: ChatItem[]): BoxCard | null {
  const item = chat.findLast(
    (i) => (i.kind === "ask" && !i.outcome) || (i.kind === "handoff" && i.state === "proposed"),
  );
  return item?.kind === "ask" || item?.kind === "handoff" ? item : null;
}

/** the line that stands for the card once it is set aside: the ask's own, or the question the
 * handoff card asks */
export function cardLine(card: BoxCard): string {
  return card.kind === "ask" ? askLine(card) : `Continue in ${card.repo.name}?`;
}

/** past this many lines the message is folded, with the fold line saying how many there are */
export const FOLD_LINES = 40;

export function lineCount(message: string): number {
  return message.split("\n").length;
}

/** The message is shown whole, since it is what the other project's agent starts from and the
 * person is the one gate on it. Only a long one folds, and never one holding a code fence: a
 * command hidden under a fold is the one thing the card exists to put in front of the person. */
export function needsFold(message: string): boolean {
  return lineCount(message) > FOLD_LINES && !/^\s*(```|~~~)/m.test(message);
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
