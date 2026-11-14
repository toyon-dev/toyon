// News: what became of the work this worktree handed off, as its agent is owed a word on it. A
// landing elsewhere and the answer to Toyon's own card are written on this chat's transcript by
// the handoff service; whether the agent has heard is read off the same transcript, since a
// message that goes to the agent carries everything written since the one before it. So nothing
// keeps a list of what is still to say: news is untold until a message follows it, and it then
// either rides that message or, where it gives the agent something to do, is the reason Toyon
// sends one once the agent is at rest.

import type { AgentEvent, NewsFrom } from "@toyon/shared";
import { answeredWithPlan, type Proposed, proposedList } from "./handoffLog.ts";
import {
  handoffActedPrompt,
  handoffDeclinedContext,
  handoffDeclinedPrompt,
  pieceLandedContext,
  pieceWakePrompt,
} from "./prompt.ts";
import { isMessage, type TranscriptEntry } from "./transcript.ts";

type Landed = Extract<AgentEvent, { type: "piece-landed" }>;
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
    const list = proposedList(entries, event.id);
    if (!list) continue;
    const withPlan = answeredWithPlan(entries, list);
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

/** names as a sentence lists them: "A", "A" and "B", "A", "B" and "C" */
function listed(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length < 2 ? q.join("") : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`;
}

/** What a landing that starts the agent has it do, as the row says it after naming the landed
 * worktrees as who the message is from, one clause for each kind of landing among them. A piece
 * of this worktree's own waited: it is started. A piece was sent into the landed worktree: the
 * landing is that worktree's own, so the agent checks that it holds the piece. Work handed off
 * with nothing here waiting for it: the agent brings in line what depends on it, which the
 * message only asks for when nothing waited. A clause about every landing named says "it" or
 * "them"; one about some of them names its own. */
function landedWhy(woke: readonly Woke[]): string[] {
  const waited = woke.filter((l) => !l.handed && !l.sent);
  const sent = woke.filter((l) => l.sent);
  const handed = woke.filter((l) => l.handed);
  const all = (ls: readonly Woke[]) => ls.length === woke.length;
  const them = (ls: readonly Woke[]) => (all(ls) ? (ls.length === 1 ? "it" : "them") : listed(ls.map((l) => l.title)));
  const why: string[] = [];
  if (waited.length > 0) {
    const pieces = [...new Set(waited.flatMap((l) => l.pieces))];
    why.push(
      pieces.length === 0
        ? `to start the piece that waited for ${them(waited)}`
        : `to start ${listed(pieces)}, which waited for ${them(waited)}`,
    );
  }
  if (sent.length > 0) {
    const they = all(sent) ? (sent.length === 1 ? "it" : "they") : listed(sent.map((l) => l.title));
    why.push(`to check that ${they} ${sent.length === 1 ? "holds the piece" : "hold the pieces"}`);
  }
  if (handed.length > 0 && waited.length === 0) why.push(`to bring in line what depends on ${them(handed)}`);
  return why;
}

/** Toyon's message for an agent at rest, from everything it has not been told, or null when none
 * of it starts the agent. One message however much is untold: a second would find the first had
 * already told it. `rest`: the worktree's own work is done (landed, nothing since), so a landing
 * elsewhere is only news to it and starts nothing; an answer on its own card still does, since
 * the person just pressed it there. `from` is the worktrees whose landing the message is for,
 * which the chat's row names as who it is from, and `why` what the agent is to do, as the row
 * says it after them: a landing's clauses first, since they speak of the worktrees just named. */
export function newsToSend(
  entries: readonly TranscriptEntry[],
  opts: { from?: number; rest?: boolean } = {},
): { text: string; why: string; from?: NewsFrom[] } | null {
  const starters = untold(entries, opts.from).filter((n) => starts(n) && !(opts.rest && n.kind === "landed"));
  if (starters.length === 0) return null;
  const text: string[] = [];
  const why: string[] = [];
  for (const n of starters) {
    if (n.kind === "answered") {
      text.push(handoffActedPrompt(n.list.pieces, n.event.outcomes, "card", n.note));
      const kept = n.event.outcomes.filter((o) => o.fate === "here" && !o.after).length;
      why.push(`to start the ${kept === 1 ? "piece" : "pieces"} kept here`);
    } else if (n.kind === "declined") {
      text.push(handoffDeclinedPrompt(n.list.pieces, n.event.note ?? ""));
      why.push("to read the note sent back with the list");
    }
  }
  const landings = starters.flatMap((n) => (n.kind === "landed" ? [n.event] : []));
  if (landings.length === 0) return { text: text.join("\n\n"), why: why.join(", and ") };
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
  why.unshift(...landedWhy(woke));
  const from = landings.map(
    (e): NewsFrom => ({ id: e.worktreeId, title: e.title, ...(e.same ? {} : { project: e.repoName }) }),
  );
  return { text: text.join("\n\n"), why: why.join(", and "), from };
}
