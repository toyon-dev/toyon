// The logic behind the pieces list, kept out of the components so it has tests without a DOM. A
// pieces list is the agent's hand-over of its work: what the plan page draws at its head, what the
// plan card's byline and Toyon's own card say about it, and what a press on a row sends.

import type { ClientMsg, Piece, PieceFate } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";

export type HandoffItem = Extract<ChatItem, { kind: "handoff" }>;

/** the list the document draws on the plan: the newest one that was not sent back. A done list
 * stays, with its outcomes, for as long as its plan is the one open. */
export function openHandoff(chat: readonly ChatItem[]): HandoffItem | null {
  const item = chat.findLast((i) => i.kind === "handoff" && i.state !== "declined");
  return item?.kind === "handoff" ? item : null;
}

/** Whether the file the list sits on is the page Toyon wrote for it (each piece's text under its
 * own heading), rather than an agent's plan. A held list has no file of its own: it sits on the
 * worktree's plan and takes the plan card's path when the card comes, as its `companion`; a list
 * shown as Toyon's own card names the page. There the block is the whole page, since the rows
 * unfold to the same text the file holds; the file itself stays, for a restart. */
export function listPage(item: Pick<HandoffItem, "plan" | "companion">): boolean {
  return !!item.plan && !item.companion;
}

/** where the piece stands: the person's last press, else what the agent proposed */
export function effectiveFate(item: Pick<HandoffItem, "fates">, piece: Piece): PieceFate {
  return item.fates[piece.id] ?? piece.fate;
}

/** what a `worktree` piece waits for before it starts: a worktree already open, or a piece of
 * the same list, named by its title; null for one that starts at once */
export type Wait = { kind: "branch"; id: string; branch: string; title: string } | { kind: "piece"; title: string };

export function waitOf(item: Pick<HandoffItem, "pieces">, piece: Piece): Wait | null {
  const after = piece.after;
  if (!after) return null;
  if ("piece" in after) {
    return { kind: "piece", title: item.pieces.find((p) => p.id === after.piece)?.title ?? "another piece" };
  }
  return { kind: "branch", ...after };
}

/** how the list would act on a yes, by fate: siblings made now, siblings queued behind a branch
 * or a piece, messages sent on, pieces kept here, and pieces skipped */
export function handoffCounts(item: Pick<HandoffItem, "pieces" | "fates">) {
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
export function handoffLine(item: Pick<HandoffItem, "pieces" | "fates">, selfId?: string): string {
  const c = handoffCounts(item);
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
export function handoffQuestion(item: Pick<HandoffItem, "pieces" | "fates">): string {
  const only = item.pieces.length === 1 ? item.pieces[0] : undefined;
  if (only) {
    if (only.fate === "send") return `Send ${only.title} to ${only.to?.title ?? "the worktree"}?`;
    if (only.fate === "here") return `Keep ${only.title} here?`;
    if (only.project) return `Continue in ${only.project.name}?`;
    return only.after ? `Queue a worktree for ${only.title}?` : `Start a worktree for ${only.title}?`;
  }
  const c = handoffCounts(item);
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
 * label and a line under it. Any fate takes a note, since an agent is sent the piece; not now
 * sends nothing to anyone. */
export interface OneRow {
  fate: PieceFate | null;
  label: string;
  description?: string;
}

/** the rows for one piece, in digit order: what the agent proposed first, so enter on an
 * untouched card is the proposal, the alternative, then not now. A piece for another project has
 * no "here": the work does not belong in this worktree. */
export function oneRows(item: Pick<HandoffItem, "pieces">, piece: Piece): OneRow[] {
  const wait = waitOf(item, piece);
  const where = wait ? ` once ${wait.kind === "branch" ? wait.branch : wait.title} lands` : "";
  const worktree: OneRow = piece.project
    ? {
        fate: "worktree",
        label: `start a worktree in ${piece.project.name}`,
        description: `a copy of that project, with this text as its plan${where}`,
      }
    : {
        fate: "worktree",
        label: wait ? "queue a worktree" : "start a worktree",
        description: `a copy of this project, with this text as its plan${where}`,
      };
  const here: OneRow = {
    fate: "here",
    label: "do it here",
    description: "this worktree's agent, after its turn",
  };
  const notNow: OneRow = { fate: null, label: "not now" };
  if (piece.fate === "send") {
    return [
      {
        fate: "send",
        label: `send to ${piece.to?.title ?? "the worktree"}`,
        description: "that worktree's agent, as a message",
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
  return "Skipped: nothing happens to it.";
}

/** Toyon's own card as the person answered it, for their bubble: the row they picked, by its
 * label on the card, and the note under it. One piece reads back the fate it went with, since
 * that row is what was pressed; a list's row was go. Null for a list no card asked about. */
export function handoffSaid(item: Pick<HandoffItem, "pieces" | "fates" | "answered">): string | null {
  const a = item.answered;
  if (!a) return null;
  if (!a.go) return "not now";
  const only = item.pieces.length === 1 ? item.pieces[0] : undefined;
  const picked = only ? oneRows(item, only).find((r) => r.fate === effectiveFate(item, only))?.label : undefined;
  const label = picked ?? "go";
  return a.note ? `${label}\n${a.note}` : label;
}

/** the answer to Toyon's own card: `note` rides with go alone, trimmed, and a blank one is left off */
export function handoffAnswer(
  item: Pick<HandoffItem, "id">,
  worktreeId: string,
  go: boolean,
  note: string | undefined,
): Extract<ClientMsg, { t: "handoff-answer" }> {
  const said = go ? note?.trim() : undefined;
  return { t: "handoff-answer", worktreeId, id: item.id, go, ...(said ? { note: said } : {}) };
}

/** a press on a row: the fate goes to the daemon, which records it for every tab */
export function pieceFate(
  item: Pick<HandoffItem, "id">,
  worktreeId: string,
  pieceId: string,
  fate: PieceFate,
): Extract<ClientMsg, { t: "handoff-fate" }> {
  return { t: "handoff-fate", worktreeId, id: item.id, pieceId, fate };
}

/** the fates a piece may take from a press: a piece aimed at an open worktree is sent there or
 * skipped; one for another project goes there or is skipped; any other goes here, to a new
 * worktree, or is skipped */
export function fatesFor(piece: Piece, pieces: readonly Piece[] = []): PieceFate[] {
  if (piece.fate === "send") return ["send", "skip"];
  // a piece that waits for one later on the list is never made in time, since go acts in list
  // order: the origin's own, or skipped
  const after = piece.after;
  const later =
    !!after &&
    "piece" in after &&
    pieces.findIndex((p) => p.id === after.piece) > pieces.findIndex((p) => p.id === piece.id);
  if (later) return ["here", "skip"];
  return piece.project ? ["worktree", "skip"] : ["here", "worktree", "skip"];
}

/** whether the list is still the person's to move */
export const deciding = (item: Pick<HandoffItem, "state">): boolean =>
  item.state === "held" || item.state === "proposed";

/** The strip's order, fixed from what the agent proposed, so a press on a fate moves no tab: the
 * origin's own pieces first, beside the plan they are part of, then worktrees made now, then the
 * queued, then what is sent on. The agent's order within each. */
export function pieceOrder(item: Pick<HandoffItem, "pieces">): Piece[] {
  const rank = (p: Piece) => (p.fate === "here" ? 0 : p.fate === "worktree" ? (p.after ? 2 : 1) : 3);
  return [...item.pieces].sort((a, b) => rank(a) - rank(b));
}

/** the small word at a tab's end: the fate while the list is the person's, what became of the
 * piece once answered; a worktree the piece became stands there by its row's dot and age instead */
export type PieceMark = { word: string } | { worktreeId: string; title?: string };

export function pieceMark(item: HandoffItem, piece: Piece): PieceMark {
  // the origin's own work that waits names what it waits for, since that is the one thing about
  // it the strip should say: "here" alone read as ready to go
  const wait = waitOf(item, piece);
  const after = wait ? { word: `after ${wait.title}` } : null;
  if (deciding(item)) {
    const fate = effectiveFate(item, piece);
    if (fate === "worktree") return { word: piece.after ? "queued" : "worktree" };
    if (fate === "send") return { word: "sent" };
    if (fate === "here" && after) return after;
    return { word: fate };
  }
  const s = pieceStanding(item, piece);
  if (s.kind === "worktree" || (s.kind === "sent" && s.worktreeId)) {
    return { worktreeId: s.worktreeId!, ...(s.title ? { title: s.title } : {}) };
  }
  if (s.kind === "here" && after) return after;
  return { word: s.kind === "sent" ? "sent" : s.kind };
}

/** Whether a piece's page carries a line under its title. Only when the line says something the
 * tab does not: before go it holds the other fates to press, and when the piece stands alone there
 * is no tab, so the line is the only place its fate is said. After go, only a row to open, a wait,
 * or a reason; a piece kept here with nothing to wait for, one skipped, and one starting are all
 * said by the tab's own word. */
export function bylineShown(item: HandoffItem, piece: Piece, alone: boolean): boolean {
  if (alone || deciding(item)) return true;
  const s = pieceStanding(item, piece);
  if (s.kind === "here") return !!piece.after;
  return s.kind !== "skipped" && s.kind !== "starting";
}

/** A piece's text split at its title: the agent's own first heading when the text opens with one,
 * so the page reads title then line then body and not line over a heading; null when it opens
 * with prose, which then takes the piece's title. */
export function leadHeading(text: string): { title: string | null; rest: string } {
  const m = /^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(text);
  if (!m) return { title: null, rest: text };
  return { title: m[1]!.trim(), rest: text.slice(m[0].length) };
}

/** what became of the piece once the list was answered, as a fact the page's line states */
export type PieceStanding =
  | { kind: "starting" }
  | { kind: "failed"; error: string }
  | { kind: "here" }
  | { kind: "skipped" }
  | { kind: "dropped"; reason: string }
  | { kind: "sent"; worktreeId?: string; title?: string; repoName?: string }
  | { kind: "worktree"; worktreeId: string; title?: string; repoName?: string }
  /** waiting for its turn: the branch it waits for, by its open row when there is one */
  | { kind: "queued"; after: Wait | null; said?: string };

export function pieceStanding(item: HandoffItem, piece: Piece): PieceStanding {
  if (item.state === "going") return { kind: "starting" };
  const outcome = item.outcomes.find((o) => o.pieceId === piece.id);
  const later = item.later.findLast((l) => l.pieceId === piece.id);
  if (!outcome) return { kind: "skipped" };
  if (outcome.error) return { kind: "failed", error: outcome.error };
  if (outcome.fate === "here") return { kind: "here" };
  if (outcome.fate === "skip") return { kind: "skipped" };
  const crossed = outcome.repoName ? { repoName: outcome.repoName } : {};
  if (outcome.fate === "send") {
    return {
      kind: "sent",
      ...(outcome.worktreeId ? { worktreeId: outcome.worktreeId } : {}),
      ...(outcome.title ? { title: outcome.title } : {}),
      ...crossed,
    };
  }
  const made = outcome.worktreeId ? outcome : later?.worktreeId ? later : null;
  if (made?.worktreeId) {
    return {
      kind: "worktree",
      worktreeId: made.worktreeId,
      ...(made.title ? { title: made.title } : {}),
      ...("repoName" in made && made.repoName ? { repoName: made.repoName } : {}),
    };
  }
  if (later?.reason) return { kind: "dropped", reason: later.reason };
  return { kind: "queued", after: waitOf(item, piece), ...(outcome.after ? { said: outcome.after } : {}) };
}

/** The tab a page opens on: the plan when the page has one, since that is the file opened. On a
 * page with none, the first piece while the list is the person's; once answered, the origin's own
 * piece, which is this worktree's plan. */
export function defaultTab(item: HandoffItem, hasPlan: boolean): string {
  if (hasPlan) return "plan";
  const order = pieceOrder(item);
  const own = deciding(item) ? undefined : order.find((p) => effectiveFate(item, p) === "here");
  return own?.id ?? order[0]?.id ?? "plan";
}

/** What the origin's own work waits for, once the list was answered: the worktrees its here
 * pieces named, a piece of the list by the worktree it became. Nothing before go, and nothing
 * for a wait that never became a worktree. Each once. */
export function hereWaits(item: HandoffItem): Array<{ id: string; title: string }> {
  if (item.state !== "done") return [];
  const out = new Map<string, string>();
  for (const piece of item.pieces) {
    const after = piece.after;
    if (!after || effectiveFate(item, piece) !== "here") continue;
    if ("id" in after) {
      out.set(after.id, after.title);
      continue;
    }
    const on = item.pieces.find((p) => p.id === after.piece);
    const became = on ? pieceStanding(item, on) : null;
    if (became?.kind === "worktree" || (became?.kind === "sent" && became.worktreeId)) {
      out.set(became.worktreeId!, became.title ?? on?.title ?? "the worktree");
    }
  }
  return [...out].map(([id, title]) => ({ id, title }));
}
