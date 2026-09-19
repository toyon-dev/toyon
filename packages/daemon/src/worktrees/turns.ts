// When a worktree's agent stops, and whether anyone has seen it since. The rail rings a worktree
// that stopped while nobody was looking and the recap line says what happened; both read the one
// record stamped here, of how the agent last stopped and what the turns since you looked did. The
// sentence on that record is the landing service's: it is written with the verdict, from the same
// question, so a finished turn with work on it has one within seconds whoever was looking.

import type { AgentStatus, TurnEnd } from "@toyon/shared";
import { factsOf, openAskOf, turnsSince } from "../agent/recap.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import type { Hub } from "../core/hub.ts";
import type { StateStore } from "../core/state.ts";

export interface TurnServiceDeps {
  state: StateStore;
  hub: Hub;
  /** the worktree's transcript as its agent session holds it; empty when no agent has run */
  transcript: (worktreeId: string) => readonly TranscriptEntry[];
  /** a turn is outstanding work on its worktree: held from its first `working` until it stops,
   * whichever way, so nothing puts the dev servers to sleep under the agent */
  hold?: (worktreeId: string, tag: string) => void;
  release?: (worktreeId: string, tag: string) => void;
}

const TURN_HOLD = "turn";

export class TurnService {
  /** the agent status each worktree last reported, so a stop is an edge and not a level */
  private lastStatus = new Map<string, AgentStatus>();
  /** worktrees someone stopped through toyon: the stop that lands next is theirs, and seen */
  private stoppedByHand = new Set<string>();

  constructor(private d: TurnServiceDeps) {
    this.boot();
    // Subscribed ahead of the ws layer's listener on the same event, which broadcasts the rows:
    // services are built before the server, so the frame this status sends carries the record.
    d.hub.on("agentStatus", (worktreeId, status) => this.onStatus(worktreeId, status));
  }

  /** A restart loses every open card: a question nobody can answer any more reads as a stop. */
  private boot() {
    let changed = false;
    for (const wt of this.d.state.worktrees) {
      const turn = wt.lastTurn;
      if (turn?.end !== "asking") continue;
      const { ask: _expired, ...facts } = turn.facts;
      turn.end = "stopped";
      turn.facts = facts;
      changed = true;
    }
    if (changed) this.d.state.save();
  }

  private onStatus(worktreeId: string, status: AgentStatus) {
    const prev = this.lastStatus.get(worktreeId) ?? "idle";
    this.lastStatus.set(worktreeId, status);
    if (status === "working") this.d.hold?.(worktreeId, TURN_HOLD);
    const edge = stopOf(prev, status);
    if (!edge) return;
    // released before the record is looked at, so a turn on a row that went away lets go too
    this.d.release?.(worktreeId, TURN_HOLD);
    const wt = this.d.state.worktree(worktreeId);
    // gone if it was removed mid-turn; a spare's agent is nobody's work yet
    if (!wt || wt.kind === "spare") return;
    const entries = this.d.transcript(worktreeId);
    const turns = turnsSince(entries, wt.seenAt ?? 0);
    const end: TurnEnd = edge === "done" && turns.at(-1)?.stop === "interrupted" ? "stopped" : edge;
    const at = Date.now();
    wt.lastTurn = { at, end, facts: factsOf(turns, end, end === "asking" ? openAskOf(entries) : undefined) };
    // a stop someone asked for is one they have seen: it should not ring the row they stopped
    if (this.stoppedByHand.delete(worktreeId) && end === "stopped") wt.seenAt = at;
    this.d.state.save();
    this.d.hub.emit("turnSettled", worktreeId, wt.lastTurn);
  }

  /** the stop-agent message: whoever sent it is looking at the stop they asked for */
  stoppedByPerson(worktreeId: string) {
    this.stoppedByHand.add(worktreeId);
  }

  /** someone is looking at this worktree right now: clear its ring */
  markSeen(worktreeId: string) {
    const wt = this.d.state.worktree(worktreeId);
    // a found worktree has no record, and no turns to have missed
    if (!wt) return;
    if (!wt.unread && wt.seenAt != null && wt.lastTurn != null && wt.seenAt >= wt.lastTurn.at) return;
    wt.unread = undefined;
    wt.seenAt = Date.now();
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the person wants to come back to this worktree: ring it until they next look at it */
  markUnread(worktreeId: string) {
    const wt = this.d.state.worktree(worktreeId);
    // a found worktree has no record to carry the mark
    if (!wt || wt.unread) return;
    wt.unread = true;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }
}

/** Which status changes are a stop. A session reports idle at birth, so only busy to idle counts;
 * blocked on a person is a stop of its own, the one most worth ringing. The finish is refined to
 * `stopped` from the transcript, which is the only place that knows it was interrupted. */
function stopOf(prev: AgentStatus, next: AgentStatus): TurnEnd | null {
  const busy = prev === "working" || prev === "waiting";
  if (next === "waiting" && prev !== "waiting") return "asking";
  if (next === "idle" && busy) return "done";
  if (next === "error" && busy) return "failed";
  return null;
}

export { isUnseen } from "@toyon/shared";
