// The logic behind the pieces list, kept out of the components so it has tests without a DOM. A
// pieces list is the agent's hand-over of its work: what the plan page draws at its head, what the
// plan card's byline and Toyon's own card say about it, and what a press on a row sends.

import type { ClientMsg, Piece, PieceFate } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";

export type PiecesItem = Extract<ChatItem, { kind: "pieces" }>;

/** the list the document draws on the plan: the newest one that was not sent back. A done list
 * stays, with its outcomes, for as long as its plan is the one open. */
export function openPieces(chat: readonly ChatItem[]): PiecesItem | null {
  const item = chat.findLast((i) => i.kind === "pieces" && i.state !== "declined");
  return item?.kind === "pieces" ? item : null;
}

/** Whether the file the list sits on is the page Toyon wrote for it (each piece's text under its
 * own heading), rather than an agent's plan. A held list has no file of its own: it sits on the
 * worktree's plan and takes the plan card's path when the card comes, as its `companion`; a list
 * shown as Toyon's own card names the page. There the block is the whole page, since the rows
 * unfold to the same text the file holds; the file itself stays, for a restart. */
export function listPage(item: Pick<PiecesItem, "plan" | "companion">): boolean {
  return !!item.plan && !item.companion;
}

/** where the piece stands: the person's last press, else what the agent proposed */
export function effectiveFate(item: Pick<PiecesItem, "fates">, piece: Piece): PieceFate {
  return item.fates[piece.id] ?? piece.fate;
}

/** what a `worktree` piece waits for before it starts: a worktree already open, or a piece of
 * the same list, named by its title; null for one that starts at once */
export type Wait = { kind: "branch"; id: string; branch: string; title: string } | { kind: "piece"; title: string };

export function waitOf(item: Pick<PiecesItem, "pieces">, piece: Piece): Wait | null {
  const after = piece.after;
  if (!after) return null;
  if ("piece" in after) {
    return { kind: "piece", title: item.pieces.find((p) => p.id === after.piece)?.title ?? "another piece" };
  }
  return { kind: "branch", ...after };
}

/** how the list would act on a yes, by fate: siblings made now, siblings queued behind a branch
 * or a piece, messages sent on, pieces kept here, and pieces skipped */
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

/** a, b and c */
const joinAnd = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The byline under a plan card that carries a list: what its yes starts, as fact. `selfId` is
 * the worktree the card is in, so a wait on its own branch reads "this branch". */
export function piecesLine(item: Pick<PiecesItem, "pieces" | "fates">, selfId?: string): string {
  const c = piecesCounts(item);
  const acts: string[] = [];
  if (c.here) acts.push("this plan here");
  if (c.worktrees) acts.push(`${plural(c.worktrees, "worktree")} now`);
  if (c.queued) {
    const waits = item.pieces.filter((p) => effectiveFate(item, p) === "worktree" && p.after);
    const own = waits.every((p) => p.after && "id" in p.after && p.after.id === selfId);
    const one = waits.length === 1 ? waitOf(item, waits[0]!) : null;
    acts.push(
      own
        ? `${c.queued} when this branch lands`
        : one
          ? `1 when ${one.kind === "branch" ? one.branch : one.title} lands`
          : `${c.queued} queued`,
    );
  }
  if (c.sent) acts.push(`${c.sent} sent on`);
  const skipped = c.skipped ? `; ${c.skipped} skipped` : "";
  if (acts.length === 0) return `Starts nothing${skipped}.`;
  return `Starts ${joinAnd(acts)}${skipped}.`;
}

/** the question Toyon's own card asks: one piece by what the agent proposed for it, a list by
 * its counts as the fates stand */
export function piecesQuestion(item: Pick<PiecesItem, "pieces" | "fates">): string {
  const only = item.pieces.length === 1 ? item.pieces[0] : undefined;
  if (only) {
    if (only.fate === "send") return `Send ${only.title} to ${only.to?.title ?? "the worktree"}?`;
    if (only.fate === "here") return `Keep ${only.title} here?`;
    if (only.project) return `Continue in ${only.project.name}?`;
    return only.after ? `Queue a worktree for ${only.title}?` : `Start a worktree for ${only.title}?`;
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

/** one row of Toyon's card for a single piece: the fate it answers with (null for not now), its
 * label, a line under it, and whether a note makes sense on it (an agent elsewhere reads it) */
export interface OneRow {
  fate: PieceFate | null;
  label: string;
  description?: string;
  notes: boolean;
}

/** the rows for one piece, in digit order: what the agent proposed first, so enter on an
 * untouched card is the proposal, the alternative, then not now. A piece for another project has
 * no "here": the work does not belong in this worktree. */
export function oneRows(item: Pick<PiecesItem, "pieces">, piece: Piece): OneRow[] {
  const wait = waitOf(item, piece);
  const where = wait ? ` once ${wait.kind === "branch" ? wait.branch : wait.title} lands` : "";
  const worktree: OneRow = piece.project
    ? {
        fate: "worktree",
        label: `start a worktree in ${piece.project.name}`,
        description: `a copy of that project, with this text as its plan${where}`,
        notes: true,
      }
    : {
        fate: "worktree",
        label: wait ? "queue a worktree" : "start a worktree",
        description: `a copy of this project, with this text as its plan${where}`,
        notes: true,
      };
  const here: OneRow = {
    fate: "here",
    label: "do it here",
    description: "this worktree's agent, after its turn",
    notes: false,
  };
  const notNow: OneRow = { fate: null, label: "not now", notes: false };
  if (piece.fate === "send") {
    return [
      {
        fate: "send",
        label: `send to ${piece.to?.title ?? "the worktree"}`,
        description: "that worktree's agent, as a message",
        notes: true,
      },
      notNow,
    ];
  }
  if (piece.fate === "here") return [here, worktree, notNow];
  return piece.project ? [worktree, notNow] : [worktree, here, notNow];
}

/** the fate as the row's words: the plain state of the piece before go */
export function fateWord(piece: Piece, fate: PieceFate): string {
  if (fate === "worktree") return piece.project ? `new worktree in ${piece.project.name}` : "new worktree";
  if (fate === "here") return "here";
  if (fate === "skip") return "skip";
  return `sent to ${piece.to?.title ?? "the worktree"}`;
}

/** what the fate does once the list is answered, as the sentence the open row states */
export function fateSentence(piece: Piece, fate: PieceFate, wait: Wait | null): string {
  if (fate === "worktree") {
    const where = piece.project ? ` in ${piece.project.name}` : "";
    const when = wait ? `, once ${wait.kind === "branch" ? wait.branch : wait.title} lands` : "";
    return `Starts as a new worktree${where}${when}, with this text as its plan.`;
  }
  if (fate === "here") return "This worktree's agent does it.";
  if (fate === "send") return `Goes to ${piece.to?.title ?? "that worktree"}'s agent as a message.`;
  return "Skipped: nothing happens to this piece.";
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
 * skipped; one for another project goes there or is skipped; any other goes here, to a new
 * worktree, or is skipped */
export function fatesFor(piece: Piece): PieceFate[] {
  if (piece.fate === "send") return ["send", "skip"];
  return piece.project ? ["worktree", "skip"] : ["here", "worktree", "skip"];
}
