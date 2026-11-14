// News: what became of the work this worktree handed off, as its agent is owed a word on it. A
// landing elsewhere and the answer to Toyon's own card are written on this chat's transcript by
// the handoff service; whether the agent has heard is read off the same transcript, since a
// message that goes to the agent carries everything written since the one before it. So nothing
// keeps a list of what is still to say: news is untold until a message follows it, and it then
// either rides that message or, where it gives the agent something to do, is the reason Toyon
// sends one once the agent is at rest.

import type { AgentEvent } from "@toyon/shared";
import {
  handoffActedPrompt,
  handoffDeclinedContext,
  handoffDeclinedPrompt,
  pieceLandedContext,
  pieceWakePrompt,
} from "./prompt.ts";
import { isMessage, type TranscriptEntry } from "./transcript.ts";

type Landed = Extract<AgentEvent, { type: "piece-landed" }>;
type Proposed = Extract<AgentEvent, { type: "handoff-proposed" }>;
type Acted = Extract<AgentEvent, { type: "handoff" }>;
type Declined = Extract<AgentEvent, { type: "handoff-declined" }>;
type Woke = Parameters<typeof pieceWakePrompt>[0][number];

/** `withPlan`: the list was answered by the plan card it rode beside, whose own reply and the
 * word sent ahead of it told the agent; `note` is what the person typed with go */
export type News =
  | { kind: "landed"; event: Landed }
  | { kind: "answered"; list: Proposed; event: Acted; note?: string; withPlan: boolean }
  | { kind: "declined"; list: Proposed; event: Declined; withPlan: boolean };

export const isNews = (e: AgentEvent): boolean =>
  e.type === "piece-landed" || e.type === "handoff" || e.type === "handoff-declined";

/** the news among `entries[start, end)`; a list is looked up over the whole transcript, since it
 * was proposed turns before its answer */
function newsIn(entries: readonly TranscriptEntry[], start: number, end: number): News[] {
  const out: News[] = [];
  for (let i = start; i < end; i++) {
    const event = entries[i]!.event;
    if (event.type === "piece-landed") {
      out.push({ kind: "landed", event });
      continue;
    }
    if (event.type !== "handoff" && event.type !== "handoff-declined") continue;
    const list = entries.findLast((e) => e.event.type === "handoff-proposed" && e.event.id === event.id)?.event;
    if (list?.type !== "handoff-proposed") continue;
    // a held list never shown as Toyon's own card was the plan card's to answer
    const withPlan = !!list.held && !entries.some((e) => e.event.type === "handoff-shown" && e.event.id === event.id);
    if (event.type === "handoff-declined") {
      out.push({ kind: "declined", list, event, withPlan });
      continue;
    }
    const go = entries.findLast((e) => e.event.type === "handoff-go" && e.event.id === event.id)?.event;
    const note = go?.type === "handoff-go" ? go.note : undefined;
    out.push({ kind: "answered", list, event, ...(note ? { note } : {}), withPlan });
  }
  return out;
}

/** The news the agent has not been told: everything since the last message it was sent. `from`
 * is for a reader that keeps its own mark of the last message, where none is on the transcript. */
export function untold(entries: readonly TranscriptEntry[], from = 0): News[] {
  let start = entries.length;
  while (start > from && !isMessage(entries[start - 1]!.event)) start--;
  return newsIn(entries, start, entries.length);
}

/** What a message is the first to carry: the news between the message before it and it. `seq`
 * is the message's own record. Not the newest record on the transcript: Toyon's own message is
 * recorded as it is queued and the person's as its turn starts, so the two can go out in the
 * other order than they were written, and each still carries what came before its own record. */
export function carried(entries: readonly TranscriptEntry[], seq: number): News[] {
  let end = entries.length - 1;
  while (end >= 0 && entries[end]!.seq !== seq) end--;
  if (end < 0) return [];
  let start = end;
  while (start > 0 && !isMessage(entries[start - 1]!.event)) start--;
  return newsIn(entries, start, end);
}

/** Whether the news gives an agent at rest something to do, so Toyon sends a message for it
 * rather than leave it for the next one: a landing the service marked as starting the agent; a
 * go on Toyon's own card that kept a piece here with nothing to wait for; words typed with not
 * now. A press that kept nothing here starts no turn, since one begun to say "sent" repeats the
 * row, and neither does a go that broke off. */
export function starts(n: News): boolean {
  if (n.kind === "landed") return !!n.event.wake;
  if (n.withPlan) return false;
  if (n.kind === "answered") return n.event.outcomes.some((o) => o.fate === "here" && !o.after);
  return !!n.event.note && !n.event.reason;
}

/** The news as the sentence a message carries behind its text. Nothing for an answer the agent
 * heard another way (a plan card's, unless a piece then failed to start) or a list Toyon closed
 * itself, which is no answer. `cards` is false for an agent without Toyon's tools: it handed
 * nothing over, so the list was the person's own and "the pieces you handed over" would be untrue. */
export function sentence(
  n: News,
  opts: { chatOf?: (worktreeId: string) => string | undefined; cards?: boolean } = {},
): string | undefined {
  if (n.kind === "landed") return pieceLandedContext(n.event, opts.chatOf?.(n.event.worktreeId));
  if (opts.cards === false) return undefined;
  const { pieces } = n.list;
  if (n.kind === "declined") {
    if (n.event.outcome === "failed") return handoffDeclinedContext(pieces, n.event.reason ?? "");
    // a reason is Toyon's own closing (handed over again, a card that went away), not an answer
    if (n.withPlan || n.event.reason) return undefined;
    return n.event.note ? handoffDeclinedPrompt(pieces, n.event.note) : handoffDeclinedContext(pieces);
  }
  if (!n.withPlan) return handoffActedPrompt(pieces, n.event.outcomes, "card", n.note);
  // the agent was told what the list would start as the plan's yes went back, before anything
  // was made: a piece that then could not start is the one thing it has not heard
  const failed = n.event.outcomes.filter((o) => o.error);
  if (failed.length === 0) return undefined;
  return handoffDeclinedContext(
    failed.map((o) => ({ title: pieces.find((p) => p.id === o.pieceId)?.title ?? o.pieceId })),
    failed.map((o) => o.error).join("; "),
  );
}

/** Whether a message Toyon sends for the news says this piece of it in its own text, so the
 * sentence behind the text is left out. A landing is said both ways: the text names the pieces
 * to do, the sentence what landed and where that chat is. */
export const inText = (n: News): boolean => n.kind !== "landed" && starts(n);

/** Toyon's message for an agent at rest, from everything it has not been told, or null when none
 * of it starts the agent. One message however much is untold: a second would find the first had
 * already told it. `rest`: the worktree's own work is done (landed, nothing since), so a landing
 * elsewhere is only news to it and starts nothing; an answer on its own card still does, since
 * the person just pressed it there. `why` is the row's word for why Toyon wrote. */
export function newsToSend(
  entries: readonly TranscriptEntry[],
  opts: { from?: number; rest?: boolean } = {},
): { text: string; why: string } | null {
  const starters = untold(entries, opts.from).filter((n) => starts(n) && !(opts.rest && n.kind === "landed"));
  if (starters.length === 0) return null;
  const text: string[] = [];
  const why: string[] = [];
  for (const n of starters) {
    if (n.kind === "answered") {
      text.push(handoffActedPrompt(n.list.pieces, n.event.outcomes, "card", n.note));
      why.push("the piece kept here, so the agent starts on it");
    } else if (n.kind === "declined") {
      text.push(handoffDeclinedPrompt(n.list.pieces, n.event.note ?? ""));
      why.push("the list was sent back with a note, so the agent reads it before going on");
    }
  }
  const landings = starters.flatMap((n) => (n.kind === "landed" ? [n.event] : []));
  if (landings.length > 0) {
    const woke = landings.map(
      (e): Woke => ({
        title: e.title,
        branch: e.branch ?? "",
        ...(e.url ? { url: e.url } : {}),
        ...(e.same ? {} : { project: e.repoName }),
        pieces: e.pieces ?? [],
        ...(e.sent ? { sent: true } : e.awaited ? {} : { handed: true }),
      }),
    );
    text.push(pieceWakePrompt(woke));
    const titles = woke.map((l) => `"${l.title}"`).join(", ");
    const pieces = new Set(woke.flatMap((l) => l.pieces));
    why.push(
      woke.every((l) => l.handed || l.sent)
        ? `${titles} landed, so the agent takes up what it handed off`
        : `${titles} landed, so the agent starts the ${pieces.size === 1 ? "piece" : "pieces"} that waited`,
    );
  }
  return { text: text.join("\n\n"), why: why.join("; ") };
}
