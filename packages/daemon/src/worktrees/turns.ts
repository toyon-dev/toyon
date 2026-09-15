// When a worktree's agent stops, and whether anyone has seen it since. The rail rings a worktree
// that stopped while nobody was looking and the recap line says what happened; both read the one
// record stamped here, of how the agent last stopped and what the turns since you looked did.
//
// A stop that stays unseen past the recap delay gets its recap: the facts at once, and a sentence
// from the agent's quick model where it has one. One sentence per time away, however many turns
// ran while you were gone.

import type { AgentStatus, TurnEnd, WorktreeInfo } from "@toyon/shared";
import { factsOf, firstAskOf, openAskOf, recapPrompt, turnsSince } from "../agent/recap.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";

export interface TurnServiceDeps {
  state: StateStore;
  hub: Hub;
  /** the worktree's transcript as its agent session holds it; empty when no agent has run */
  transcript: (worktreeId: string) => readonly TranscriptEntry[];
  /** a recap's sentence from the worktree's own agent, or null; without it every recap is facts */
  summarize?: (wt: WorktreeInfo, prompt: string) => Promise<string | null>;
  /** how long a stop stays unseen before its recap is due */
  delayMs?: number;
  /** a turn is outstanding work on its worktree: held from its first `working` until it stops,
   * whichever way, so nothing puts the dev servers to sleep under the agent */
  hold?: (worktreeId: string, tag: string) => void;
  release?: (worktreeId: string, tag: string) => void;
}

const TURN_HOLD = "turn";

/** Long enough that moving between two busy worktrees never writes one, and short of the five
 * minutes an idle adapter lives, so the sentence is asked of a process that is still up. */
const RECAP_DELAY_MS = Number(process.env.TOYON_RECAP_DELAY_MS) || 2 * 60_000;

export class TurnService {
  /** the agent status each worktree last reported, so a stop is an edge and not a level */
  private lastStatus = new Map<string, AgentStatus>();
  /** worktrees someone stopped through toyon: the stop that lands next is theirs, and seen */
  private stoppedByHand = new Set<string>();
  /** the recap timer per worktree, armed on its latest stop */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** the `seenAt` each worktree's last sentence was written for: one per time away */
  private summarized = new Map<string, number>();

  constructor(private d: TurnServiceDeps) {
    this.boot();
    // Subscribed ahead of the ws layer's listener on the same event, which broadcasts the rows:
    // services are built before the server, so the frame this status sends carries the record.
    d.hub.on("agentStatus", (worktreeId, status) => this.onStatus(worktreeId, status));
  }

  /** A restart loses the timers and every open card. What stopped unseen gets its facts now,
   * never a model call at boot, and a question nobody can answer any more reads as a stop. */
  private boot() {
    const now = Date.now();
    let changed = false;
    for (const wt of this.d.state.worktrees) {
      const turn = wt.lastTurn;
      if (!turn) continue;
      if (turn.end === "asking") {
        const { ask: _expired, ...facts } = turn.facts;
        turn.end = "stopped";
        turn.facts = facts;
        changed = true;
      }
      if (!turn.recap && (wt.seenAt ?? 0) < turn.at) {
        turn.recap = { at: now };
        changed = true;
      }
    }
    if (changed) this.d.state.save();
  }

  private onStatus(worktreeId: string, status: AgentStatus) {
    const prev = this.lastStatus.get(worktreeId) ?? "idle";
    this.lastStatus.set(worktreeId, status);
    // a new turn: whatever was due for the last stop no longer is
    if (status === "working") {
      this.disarm(worktreeId);
      this.d.hold?.(worktreeId, TURN_HOLD);
    }
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
    this.disarm(worktreeId);
    if ((wt.seenAt ?? 0) < at) this.arm(worktreeId, at);
    this.d.state.save();
    this.d.hub.emit("turnSettled", worktreeId, wt.lastTurn);
  }

  private arm(worktreeId: string, at: number) {
    const t = setTimeout(() => this.due(worktreeId, at), this.d.delayMs ?? RECAP_DELAY_MS);
    // a recap still pending must not keep a test, or a shutdown, waiting
    t.unref?.();
    this.timers.set(worktreeId, t);
  }

  private disarm(worktreeId: string) {
    const t = this.timers.get(worktreeId);
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(worktreeId);
  }

  private due(worktreeId: string, at: number) {
    this.timers.delete(worktreeId);
    const wt = this.d.state.worktree(worktreeId);
    const turn = wt?.lastTurn;
    // looked at, moved on, or removed while the timer ran
    if (!wt || !turn || turn.at !== at || (wt.seenAt ?? 0) >= at) return;
    turn.recap = { at: Date.now() };
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    // A login problem is the whole story already. And a second stop in the same time away keeps
    // to the one sentence: its line is the facts, rather than a second model call.
    const seenAt = wt.seenAt ?? 0;
    const summarize = this.d.summarize;
    if (!summarize || turn.facts.auth) return;
    if (this.summarized.get(worktreeId) === seenAt) return;
    this.summarized.set(worktreeId, seenAt);
    const entries = this.d.transcript(worktreeId);
    const prompt = recapPrompt({
      title: wt.title,
      firstAsk: firstAskOf(entries),
      turns: turnsSince(entries, seenAt),
      end: turn.end,
      facts: turn.facts,
    });
    fireAndForget(worktreeId, this.write(worktreeId, at, summarize(wt, prompt)), "recap summary");
  }

  private async write(worktreeId: string, at: number, sentence: Promise<string | null>) {
    const text = await sentence;
    const turn = this.d.state.worktree(worktreeId)?.lastTurn;
    // a newer stop replaced the record while the sentence was written: it describes the old one
    if (!text || turn?.at !== at || !turn.recap) return;
    turn.recap.text = text;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the stop-agent message: whoever sent it is looking at the stop they asked for */
  stoppedByPerson(worktreeId: string) {
    this.stoppedByHand.add(worktreeId);
  }

  /** someone is looking at this worktree right now: clear its ring, and any recap still to come */
  markSeen(worktreeId: string) {
    this.disarm(worktreeId);
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

/** it stopped since anyone last looked, or someone marked it to come back to. A worktree with no
 * record reads as seen. */
export function isUnseen(wt: WorktreeInfo): boolean {
  return wt.unread === true || (wt.lastTurn != null && (wt.seenAt == null || wt.seenAt < wt.lastTurn.at));
}
