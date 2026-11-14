// News: what happened that this worktree's agent is owed a word on. What became of the work it
// handed off (a landing elsewhere, the answer to Toyon's own card, a worktree gone before it
// landed, a queued piece dropped) and a failure that is its to fix (the repo's check, a hook, a
// conflict) are written on this chat's transcript by the service that met them; whether the
// agent has heard is read off the same transcript, since a message that goes to the agent carries
// everything written since the one before it. So nothing keeps a list of what is still to say,
// and no service sends the agent a message for a fact: news is untold until a message follows it,
// and it then either rides that message or, where it gives the agent something to do, is the
// reason Toyon sends one once the agent is at rest.

import type { AgentEvent, NewsFrom } from "@toyon/shared";
import { recordedFailure } from "./failure.ts";
import { answeredWithPlan, type Proposed, proposedList } from "./handoffLog.ts";
import {
  failureContext,
  fixPrompt,
  fixTo,
  handoffActedPrompt,
  handoffDeclinedContext,
  handoffDeclinedPrompt,
  type OwnFailure,
  pieceDroppedContext,
  pieceGoneContext,
  pieceGonePrompt,
  pieceLandedContext,
  pieceWakePrompt,
} from "./prompt.ts";
import { isMessage, type TranscriptEntry } from "./transcript.ts";

type Landed = Extract<AgentEvent, { type: "piece-landed" }>;
type Acted = Extract<AgentEvent, { type: "handoff" }>;
type Declined = Extract<AgentEvent, { type: "handoff-declined" }>;
type FailureNote = Extract<AgentEvent, { type: "failure" }>;
type Gone = Extract<AgentEvent, { type: "piece-gone" }>;
type Dropped = Extract<AgentEvent, { type: "piece-dropped" }>;
type Woke = Parameters<typeof pieceWakePrompt>[0][number];

/** `withPlan`: the list was answered by the plan card it rode beside, whose own reply and the
 * word sent ahead of it told the agent; `note` is what the person typed with go. `failure` is
 * the record with what its row printed. `again`: the check failed straight after a message of
 * Toyon's own that was about the check, so the turn sent to fix it ended in the same failure.
 * `title` is the dropped piece's, when its list is still on the transcript. */
export type News =
  | { kind: "landed"; event: Landed }
  | { kind: "answered"; list: Proposed; event: Acted; note?: string; withPlan: boolean }
  | { kind: "declined"; list: Proposed; event: Declined; withPlan: boolean }
  | { kind: "failed"; event: FailureNote; failure: OwnFailure; again: boolean }
  | { kind: "gone"; event: Gone }
  | { kind: "dropped"; event: Dropped; title?: string };

export const isNews = (e: AgentEvent): boolean =>
  e.type === "piece-landed" ||
  e.type === "handoff" ||
  e.type === "handoff-declined" ||
  e.type === "failure" ||
  e.type === "piece-gone" ||
  e.type === "piece-dropped";

/** Whether the message before `at` was Toyon's own and about the check: a press on the check's
 * row, or the message Toyon sent on its own that carried a failed check. The check that failed
 * at `at` is then the one that message's turn ended in. */
function afterCheckAsk(entries: readonly TranscriptEntry[], at: number): boolean {
  let i = at - 1;
  while (i >= 0 && !isMessage(entries[i]!.event)) i--;
  const message = i < 0 ? undefined : entries[i]!.event;
  if (message?.type !== "fix-asked") return false;
  if (message.kind === "check") return true;
  if (message.kind !== "news") return false;
  let start = i;
  while (start > 0 && !isMessage(entries[start - 1]!.event)) start--;
  return newsIn(entries, start, i).some((n) => n.kind === "failed" && n.event.kind === "check");
}

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
    if (event.type === "failure") {
      const failure = recordedFailure(entries, event);
      if (failure) {
        out.push({ kind: "failed", event, failure, again: event.kind === "check" && afterCheckAsk(entries, i) });
      }
      continue;
    }
    if (event.type === "piece-gone") {
      out.push({ kind: "gone", event });
      continue;
    }
    if (event.type === "piece-dropped") {
      const title = proposedList(entries, event.id)?.pieces.find((p) => p.id === event.pieceId)?.title;
      out.push({ kind: "dropped", event, ...(title ? { title } : {}) });
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
 * is the message's own record, not the newest on the transcript: a message steered into a turn
 * is recorded ahead of the request that carries it, and another may be recorded meanwhile. */
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
 * now; a failure that is the agent's to fix; a worktree gone that a piece here waited for. A
 * press that kept nothing here starts no turn, since one begun to say "sent" repeats the row,
 * and neither does a go that broke off, or a queued piece dropped, which leaves nothing to do.
 *
 * The check is asked about once and not twice in a row: the turn sent to fix it ends in the same
 * check, and an agent that cannot make it pass would go round for good. The second failure
 * waits for a message that is not Toyon's own about the check, and rides it. A hook or a
 * conflict comes back only through another press of commit, land or sync, so a cap there would
 * drop the second refusal with nobody told. */
export function starts(n: News): boolean {
  if (n.kind === "landed" || n.kind === "gone") return !!n.event.wake;
  if (n.kind === "failed") return !n.again;
  if (n.kind === "dropped") return false;
  if (n.withPlan) return false;
  if (n.kind === "answered") return n.event.outcomes.some((o) => o.fate === "here" && !o.after);
  return !!n.event.note && !n.event.reason;
}

/** The news as the sentence a message carries behind its text. Nothing for an answer the agent
 * heard another way (a plan card's, unless a piece then failed to start) or a list Toyon closed
 * itself, which is no answer. `cards` is false for an agent without Toyon's tools: it handed
 * nothing over, so the list was the person's own and "the pieces you handed over" would be untrue.
 * `said`: the message is Toyon's own for this news and its text says it, so what rides behind is
 * only what the text leaves out. A landing is said both ways: the text names the pieces to do,
 * the sentence what landed and where that chat is. A failure's text says what to fix and the
 * sentence shows what was printed; a conflict that rides a message of the person's carries the
 * ask as well, since a conflict with no step shown is otherwise no word at all. */
export function sentence(
  n: News,
  opts: { chatOf?: (worktreeId: string) => string | undefined; cards?: boolean; said?: boolean } = {},
): string | undefined {
  if (n.kind === "landed") return pieceLandedContext(n.event, opts.chatOf?.(n.event.worktreeId));
  if (n.kind === "failed") {
    const shown = failureContext(n.failure);
    if (opts.said || n.failure.kind !== "conflict") return shown;
    return [fixPrompt(n.failure), ...(shown ? [shown] : [])].join("\n\n");
  }
  if (opts.said) return undefined;
  if (n.kind === "gone") return pieceGoneContext(n.event);
  if (n.kind === "dropped") return pieceDroppedContext(n.title, n.event.reason);
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

/** names as a sentence lists them: "A", "A" and "B", "A", "B" and "C" */
function listed(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length < 2 ? q.join("") : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`;
}

/** What a landing that starts the agent has it do, as the row says it after naming the landed
 * worktrees as who the message is from, one clause for each kind of landing among them. A piece
 * of this worktree's own waited: it is started. A piece was sent into the landed worktree, or
 * the landed worktree was made from one: the agent checks the landing against the piece this
 * chat wrote, which for work handed off the message only asks when nothing waited. A clause
 * about every landing named says "it" or "them"; one about some of them names its own. This
 * worktree's own landing is named by no one (`own`), so its clause says what the part waited
 * for in words, after the clauses that speak of the worktrees named. */
function landedWhy(woke: readonly Woke[]): string[] {
  const named = woke.filter((l) => !l.own);
  const own = woke.filter((l) => l.own);
  const waited = named.filter((l) => !l.handed && !l.sent);
  const checked = named.filter((l) => l.sent || (l.handed && waited.length === 0 && own.length === 0));
  const all = (ls: readonly Woke[]) => ls.length === named.length;
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
  if (checked.length > 0) {
    why.push(`to check ${them(checked)} against the ${checked.length === 1 ? "piece" : "pieces"} written here`);
  }
  if (own.length > 0) {
    const pieces = [...new Set(own.flatMap((l) => l.pieces))];
    why.push(
      pieces.length === 0
        ? "to start the piece that waited for this worktree to land"
        : `to start ${listed(pieces)}, which waited for this worktree to land`,
    );
  }
  return why;
}

/** Toyon's message for an agent at rest, from everything it has not been told, or null when none
 * of it starts the agent. One message however much is untold: a second would find the first had
 * already told it. `rest`: the worktree's own work is done (landed, nothing since), so a landing
 * elsewhere, or a worktree gone, is only news to it and starts nothing; an answer on its own card
 * still does, since the person just pressed it there, and so does its own landing when a part of
 * its work waited for it, since being at rest is then the very thing the part waited for. `from`
 * is the worktrees whose landing the message is for, which the chat's row names as who it is
 * from, and `why` what the agent is to do, as the row says it after them: a landing's clauses
 * first, since they speak of the worktrees just named. This worktree's own landing is not among
 * them: a chip for this chat would name the row the reader is in. `said` is the news the text
 * itself says, which the sentences behind the message leave out (`sentence`), and `toolId` the
 * row of a failed command the message is sent to fix, which is then not offered again. */
export function newsToSend(
  entries: readonly TranscriptEntry[],
  opts: { from?: number; rest?: boolean } = {},
): { text: string; why: string; from?: NewsFrom[]; toolId?: string; said: AgentEvent[] } | null {
  const starters = untold(entries, opts.from).filter(
    (n) => starts(n) && !(opts.rest && ((n.kind === "landed" && !n.event.own) || n.kind === "gone")),
  );
  if (starters.length === 0) return null;
  const text: string[] = [];
  const why: string[] = [];
  let toolId: string | undefined;
  for (const n of starters) {
    if (n.kind === "answered") {
      text.push(handoffActedPrompt(n.list.pieces, n.event.outcomes, "card", n.note));
      const kept = n.event.outcomes.filter((o) => o.fate === "here" && !o.after).length;
      why.push(`to start the ${kept === 1 ? "piece" : "pieces"} kept here`);
    } else if (n.kind === "declined") {
      text.push(handoffDeclinedPrompt(n.list.pieces, n.event.note ?? ""));
      why.push("to read the note sent back with the list");
    } else if (n.kind === "failed") {
      text.push(fixPrompt(n.failure));
      why.push(fixTo(n.failure));
      toolId = n.event.toolId ?? toolId;
    }
  }
  const gone = starters.flatMap((n) => (n.kind === "gone" ? [n.event] : []));
  if (gone.length > 0) {
    const pieces = [...new Set(gone.flatMap((g) => g.pieces ?? []))];
    text.push(pieceGonePrompt(gone));
    why.push(
      `to see whether ${pieces.length ? listed(pieces) : "the piece that waited"} can go ahead without ${gone.length === 1 ? "it" : "them"}`,
    );
  }
  const said = starters.map((n) => n.event);
  const fixed = toolId ? { toolId } : {};
  const landings = starters.flatMap((n) => (n.kind === "landed" ? [n.event] : []));
  if (landings.length === 0) return { text: text.join("\n\n"), why: why.join(", and "), ...fixed, said };
  const woke = landings.map(
    (e): Woke => ({
      title: e.title,
      branch: e.branch ?? "",
      ...(e.url ? { url: e.url } : {}),
      ...(e.same ? {} : { project: e.repoName }),
      pieces: e.pieces ?? [],
      ...(e.brief ? { brief: e.brief } : {}),
      ...(e.own ? { own: true } : e.sent ? { sent: true } : e.awaited ? {} : { handed: true }),
    }),
  );
  text.push(pieceWakePrompt(woke));
  why.unshift(...landedWhy(woke));
  const from = landings
    .filter((e) => !e.own)
    .map((e): NewsFrom => ({ id: e.worktreeId, title: e.title, ...(e.same ? {} : { project: e.repoName }) }));
  return { text: text.join("\n\n"), why: why.join(", and "), ...(from.length ? { from } : {}), ...fixed, said };
}
