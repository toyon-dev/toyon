// A pieces list's state, read off the transcript. A list is open from its `handoff-proposed`
// until a `handoff-go`, `handoff` or `handoff-declined` with the same id; one proposed in plan
// mode is held for a plan card until a `handoff-shown` makes it Toyon's own. Everything that asks
// where a list stands asks here: the session (what its row waits on, which list a plan card
// carries and answers), the handoff service (what go acts on), and the news (who answered it).
// Nothing keeps a copy, so a restart, a second reader and a replay all see the same thing.

import type { AgentEvent, Piece, PieceFate } from "@toyon/shared";
import type { TranscriptEntry } from "./transcript.ts";

export type Proposed = Extract<AgentEvent, { type: "handoff-proposed" }>;
type PlanCard = Extract<AgentEvent, { type: "agent-permission" }>;

/** the events that open or close a list, or move it between a plan card and a card of its own */
export const isListEvent = (e: AgentEvent): boolean =>
  e.type === "handoff-proposed" ||
  e.type === "handoff-shown" ||
  e.type === "handoff-go" ||
  e.type === "handoff" ||
  e.type === "handoff-declined";

/** the proposal a list id names */
export function proposedList(entries: readonly TranscriptEntry[], id: string): Proposed | undefined {
  const list = entries.findLast(({ event }) => event.type === "handoff-proposed" && event.id === id)?.event;
  return list?.type === "handoff-proposed" ? list : undefined;
}

/** the plan card open on a chat, if one is: an `agent-permission` with a plan and no end yet */
export function openPlanCard(entries: readonly TranscriptEntry[]): PlanCard | null {
  const open = new Map<string, PlanCard>();
  for (const { event } of entries) {
    if (event.type === "agent-permission" && event.plan) open.set(event.id, event);
    else if (event.type === "agent-ask-end") open.delete(event.id);
  }
  return [...open.values()].at(-1) ?? null;
}

/** the proposals on a transcript nothing has closed, newest last */
export function openHandoff(entries: readonly TranscriptEntry[]): Proposed[] {
  const open = new Map<string, Proposed>();
  for (const { event } of entries) {
    if (event.type === "handoff-proposed") open.set(event.id, event);
    else if (event.type === "handoff-go" || event.type === "handoff" || event.type === "handoff-declined")
      open.delete(event.id);
  }
  return [...open.values()];
}

/** whether a held list became Toyon's own card */
const wasShown = (entries: readonly TranscriptEntry[], id: string): boolean =>
  entries.some(({ event }) => event.type === "handoff-shown" && event.id === id);

/** the held list still waiting for a plan card: one shown as Toyon's own card keeps `held` on its
 * event but belongs to no card, so it is not this */
export function heldUnshown(entries: readonly TranscriptEntry[]): Proposed | null {
  return openHandoff(entries).find((p) => p.held && !wasShown(entries, p.id)) ?? null;
}

/** The open lists that are Toyon's own card: proposed outside plan mode, or held and since
 * shown. These are a person's answer owed with no turn running, which is what a row reads
 * `waiting` from; a list held for a plan card is that card's wait, not its own. */
export function ownCards(entries: readonly TranscriptEntry[]): Proposed[] {
  return openHandoff(entries).filter((p) => !p.held || wasShown(entries, p.id));
}

/** whether a list was the plan card's to answer: held, and never shown as Toyon's own card */
export function answeredWithPlan(entries: readonly TranscriptEntry[], list: Proposed): boolean {
  return !!list.held && !wasShown(entries, list.id);
}

/** The file a list sits on, as the transcript names it: the page Toyon wrote when the list was
 * proposed as its own card or shown as one after its turn, else the plan of the card a held list
 * rode beside, which is the only place a held list's file is named. A sibling's pointer reads
 * the whole picture there. */
export function listFile(entries: readonly TranscriptEntry[], id: string): string | undefined {
  let file: string | undefined;
  for (const { event } of entries) {
    if ((event.type === "handoff-proposed" || event.type === "handoff-shown") && event.id === id && event.plan) {
      file = event.plan;
    } else if (event.type === "agent-permission" && event.handoff === id && event.plan) file = event.plan;
  }
  return file;
}

/** where the piece stands as go is pressed: the last fate the person set, else the agent's */
export function effectiveFate(entries: readonly TranscriptEntry[], proposal: Proposed, piece: Piece): PieceFate {
  let fate: PieceFate = piece.fate;
  for (const { event } of entries) {
    if (event.type === "handoff-fate" && event.id === proposal.id && event.pieceId === piece.id) fate = event.fate;
  }
  return fate;
}

/** The fates the person pressed on the last list, by piece title, when that list went back with
 * its plan: a held list the no took with it. The next list is that plan's next draft, so a
 * piece with the same title is the same piece and the person's word on it stands; a list they
 * answered as a card (not now) was an answer, and nothing carries from it. */
export function pressedOnSentBack(entries: readonly TranscriptEntry[]): Map<string, PieceFate> {
  const pressed = new Map<string, PieceFate>();
  const last = entries.findLast(({ event }) => event.type === "handoff-proposed")?.event;
  if (last?.type !== "handoff-proposed" || !last.held) return pressed;
  let back = false;
  for (const { event } of entries) {
    if (event.type === "handoff-shown" && event.id === last.id) return pressed;
    if (event.type === "handoff-declined" && event.id === last.id) back = !event.outcome;
  }
  if (!back) return pressed;
  for (const { event } of entries) {
    if (event.type === "handoff-fate" && event.id === last.id) {
      const title = last.pieces.find((p) => p.id === event.pieceId)?.title;
      if (title) pressed.set(title.toLowerCase(), event.fate);
    }
  }
  return pressed;
}
