// The logic behind the pieces list, kept out of the components so it has tests without a DOM. A
// pieces list is the agent's hand-over of its plan's work: what the document draws at the head of
// the plan, what the yes line and Toyon's own card say about it, and what a press on a row sends.

import type { ClientMsg, Piece, PieceFate } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";

export type PiecesItem = Extract<ChatItem, { kind: "pieces" }>;

/** the list the document draws on the plan: the newest one that was not sent back. A done list
 * stays, with its outcomes, for as long as its plan is the one open. */
export function openPieces(chat: readonly ChatItem[]): PiecesItem | null {
  const item = chat.findLast((i) => i.kind === "pieces" && i.state !== "declined");
  return item?.kind === "pieces" ? item : null;
}

/** A list of one, as Toyon's own card: an offer, not a card. The agent came across one thing
 * mid-task and the box is not its to take for that; the line above the box says start, and the
 * person types on. A list of two or more is the card, since the fates on it are read on the plan. */
export function isOffer(item: Pick<PiecesItem, "state" | "pieces">): boolean {
  return item.state === "proposed" && item.pieces.length === 1;
}

/** where the piece stands: the person's last press, else what the agent proposed */
export function effectiveFate(item: Pick<PiecesItem, "fates">, piece: Piece): PieceFate {
  return item.fates[piece.id] ?? piece.fate;
}

/** how the list would act on a yes, by fate: siblings made now, siblings queued behind a branch,
 * messages sent on, pieces kept here, and pieces skipped */
export function piecesCounts(item: Pick<PiecesItem, "pieces" | "fates">) {
  const counts = { worktrees: 0, queued: 0, sent: 0, here: 0, skipped: 0 };
  for (const piece of item.pieces) {
    const fate = effectiveFate(item, piece);
    if (fate === "worktree") {
      if (piece.after) counts.queued++;
      else counts.worktrees++;
    } else if (fate === "send") counts.sent++;
    else if (fate === "here") counts.here++;
    else counts.skipped++;
  }
  return counts;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** the line above the plan card: what its yes also does, acts first, then what stays put */
export function piecesLine(item: Pick<PiecesItem, "pieces" | "fates">): string {
  const c = piecesCounts(item);
  const acts = [
    c.worktrees ? plural(c.worktrees, "worktree") : "",
    c.queued ? `${c.queued} queued` : "",
    c.sent ? plural(c.sent, "message") : "",
  ].filter(Boolean);
  const stays = [c.here ? `${c.here} here` : "", c.skipped ? `${c.skipped} skipped` : ""].filter(Boolean);
  if (acts.length === 0) return `with yes: nothing starts; ${stays.join(", ") || "nothing on the list"}`;
  return `with yes: ${acts.join(", ")}${stays.length ? `; ${stays.join(", ")}` : ""}`;
}

/** the question Toyon's own card asks: the one-piece shape first, since a thing found mid-task is
 * one piece, then the counts for a list */
export function piecesQuestion(item: Pick<PiecesItem, "pieces" | "fates">): string {
  const only = item.pieces.length === 1 ? item.pieces[0] : undefined;
  if (only) {
    const fate = effectiveFate(item, only);
    if (fate === "worktree")
      return only.after ? `Queue a worktree for ${only.title}?` : `Start a worktree for ${only.title}?`;
    if (fate === "send") return `Send ${only.title} to ${only.to?.title ?? "the worktree"}?`;
    if (fate === "here") return `Keep ${only.title} here?`;
    return `Skip ${only.title}?`;
  }
  const c = piecesCounts(item);
  const parts = [
    c.worktrees ? `start ${plural(c.worktrees, "worktree")}` : "",
    c.queued ? `queue ${c.queued}` : "",
    c.sent ? `send ${c.sent}` : "",
    c.here ? `do ${c.here} here` : "",
    c.skipped ? `skip ${c.skipped}` : "",
  ].filter(Boolean);
  const line = parts.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}?`;
}

/** the answer to Toyon's own card: `note` rides with go alone, trimmed, and a blank one is left off */
export function piecesAnswer(
  item: Pick<PiecesItem, "id">,
  worktreeId: string,
  go: boolean,
  note: string | undefined,
): Extract<ClientMsg, { t: "pieces-answer" }> {
  const said = go ? note?.trim() : undefined;
  return { t: "pieces-answer", worktreeId, id: item.id, go, ...(said ? { note: said } : {}) };
}

/** a press on a row: the fate goes to the daemon, which records it for every tab */
export function pieceFate(
  item: Pick<PiecesItem, "id">,
  worktreeId: string,
  pieceId: string,
  fate: PieceFate,
): Extract<ClientMsg, { t: "pieces-fate" }> {
  return { t: "pieces-fate", worktreeId, id: item.id, pieceId, fate };
}

/** the fates a piece may take from a press: a piece aimed at an open worktree is sent there or
 * skipped; any other goes here, to a new worktree, or is skipped */
export function fatesFor(piece: Piece): PieceFate[] {
  return piece.fate === "send" ? ["send", "skip"] : ["here", "worktree", "skip"];
}
