// The one place a failure is answered. Whoever meets one (a landing op, the check after a turn, a
// press on the boot pane or on a failed command's offer) names it as a Failure and reports it
// here; the table says what follows. A failure that is the agent's to fix is written on the chat
// as news it is owed, and the message for it is the session's to send (agent/news.ts): nothing
// here sends the agent a message for a fact. A press is a person asking, and that is sent from
// here as Toyon's own message, so the transcript shows what failed where a bubble nobody typed
// would have stood. The press that sends the agent on after a stop or an error is answered here
// too: not a failure to fix, but the same kind of message, Toyon's own and shown as its reason.

import type { AgentEvent, Failed } from "@toyon/shared";
import { isMain } from "@toyon/shared";
import type { AgentAdapter } from "../agent/adapter.ts";
import { rowFailure } from "../agent/failure.ts";
import { untold } from "../agent/news.ts";
import {
  type Failure,
  failedRun,
  failureContext,
  fixPrompt,
  fixWhy,
  goOnPrompt,
  goOnWhy,
  type OwnFailure,
  type Stop,
} from "../agent/prompt.ts";
import { isMessage, type TranscriptEntry } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

export interface FixServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor">;
}

/** What follows a failure. `tell` writes it on the chat as news the agent is owed: Toyon sends
 * the message that fixes it once the agent is at rest, unasked, or it rides a message of the
 * person's that goes first, and the check is told that way once and not twice in a row
 * (agent/news.ts). `offer` does nothing until a person presses for it.
 *
 * A person's own command is offered and never told: many fail on purpose. A dev server that is
 * down is offered by the boot pane's own button. */
export const RESPONSE: Record<Failure["kind"], "tell" | "offer"> = {
  hook: "tell",
  conflict: "tell",
  check: "tell",
  command: "offer",
  preview: "offer",
};

/** the row was handed to the agent already */
function askedFor(entries: readonly TranscriptEntry[], toolId: string): boolean {
  return entries.some(({ event }) => event.type === "fix-asked" && event.toolId === toolId);
}

/** a failure as the chat's record keeps it: the row it is about, and no copy of what was printed */
function recordOf(f: OwnFailure): Failed {
  if (f.kind === "check") return { kind: "check", toolId: f.toolId };
  if (f.kind === "hook") return { kind: "hook", hook: f.hook, toolId: f.toolId };
  return {
    kind: "conflict",
    base: f.base,
    how: f.how,
    ...(f.step ? { toolId: f.step.toolId } : {}),
    ...(f.carried ? { carried: f.carried } : {}),
  };
}

/** How the chat ends, when it ends on a turn that was stopped or that failed and nothing has been
 * said since: the same reading the box makes to offer the press, so a press on a stale page sends
 * nothing. The figures a turn leaves behind it are not words, so they are read past; so is the
 * end of a turn that failed, was refused a login or was lost with its daemon, to the row before
 * it that says why. Null once anything else is the last thing, including the ask a press already
 * sent. */
export function lastStop(entries: readonly TranscriptEntry[]): Stop | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    // nor is a failure's record, which draws nothing on the chat
    if (e.type === "usage" || e.type === "session-info" || e.type === "failure") continue;
    if (e.type === "turn-end" && (e.stopReason === "failed" || e.stopReason === "auth" || e.stopReason === "lost"))
      continue;
    if (e.type === "turn-end" && e.stopReason === "interrupted") return { kind: "stopped" };
    if (e.type === "agent-error") return { kind: "failed", error: e.message };
    return null;
  }
  return null;
}

export class FixService {
  constructor(private d: FixServiceDeps) {
    d.hub.on("checkFailed", (id, run) => {
      this.report(id, { kind: "check", ...run });
    });
  }

  /** The agent a failure on this worktree is told to, or null: nothing runs on main, and a
   * worktree still starting has none. */
  private agentOf(worktreeId: string): AgentAdapter | null {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || isMain(wt)) return null;
    return this.d.runtime.agentFor(worktreeId) ?? null;
  }

  /** A failure met on a worktree, answered by the table: one that is the agent's to fix is
   * written on its chat, and the session sends the message for it. `sent` when that message went
   * as the failure was written, which is not the person's send, and the rail does not move for
   * it. `waits` when the failure is written and the agent has not been told yet: a card is up,
   * a turn is running, the row is held, or the check failed straight after a message about the
   * check. Null when nothing is owed: the table offers this one, nothing runs on main, there is
   * no agent here, the row was handed over already, or the row is not on the chat to show. */
  report(worktreeId: string, failure: Failure): "sent" | "waits" | null {
    if (failure.kind === "command" || failure.kind === "preview") return null;
    const agent = this.agentOf(worktreeId);
    if (!agent) return null;
    const toolId = failedRun(failure)?.toolId;
    if (toolId && askedFor(agent.transcript(), toolId)) return null;
    const event: AgentEvent = { type: "failure", ts: Date.now(), ...recordOf(failure) };
    agent.note(event);
    // told is read the way news reads it: a message went to the agent after the record
    const entries = agent.transcript();
    const at = entries.findLastIndex((e) => e.event === event);
    if (entries.slice(at + 1).some((e) => isMessage(e.event))) {
      this.d.hub.emit("fixAsked", worktreeId);
      return "sent";
    }
    // a check or a hook whose row is not on the chat leaves nothing to show the agent, and is
    // no news: nothing waits
    return untold(entries).some((n) => n.event === event) ? "waits" : null;
  }

  /** A person asking for the fix: the message goes now, as Toyon's own, for a failure the table
   * only offers as much as for one it tells, and the check's once does not hold it back. False
   * when nothing was sent: nothing runs on main, there is no agent here, or the row was handed
   * over already. */
  ask(worktreeId: string, failure: Failure): boolean {
    const agent = this.agentOf(worktreeId);
    if (!agent) return false;
    const toolId = failedRun(failure)?.toolId;
    if (toolId && askedFor(agent.transcript(), toolId)) return false;
    const context = failureContext(failure);
    agent.send(fixPrompt(failure), {
      asked: { kind: failure.kind, why: fixWhy(failure), ...(toolId ? { toolId } : {}) },
      ...(context ? { context: [context] } : {}),
    });
    this.d.hub.emit("fixAsked", worktreeId);
    return true;
  }

  /** The press on a row's offer: the failure is read back off the transcript, never taken from
   * the client. A second press on a row already handed over is not an error and sends nothing. */
  press(worktreeId: string, toolId: string): void {
    this.d.state.requireWorktree(worktreeId);
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    const entries = agent.transcript();
    const failure = rowFailure(entries, toolId);
    if (!failure) throw new UserError("nothing to fix on that row");
    if (askedFor(entries, toolId)) return;
    if (!this.ask(worktreeId, failure)) throw new UserError("nothing runs on main");
  }

  /** The press that sends the agent on after a stop or an error: Toyon's own message, read off
   * how the transcript ends and never from the client. A second press after the first was heard
   * finds the ask last and sends nothing, like a second press on a row. An agent that failed has
   * no process; its next send starts one, as a message of the person's would. */
  goOn(worktreeId: string): void {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (isMain(wt)) throw new UserError("nothing runs on main");
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    const entries = agent.transcript();
    const stop = lastStop(entries);
    if (!stop) {
      // the page's offer was on a chat that has since moved on: already sent on, or spoken to
      if (entries.at(-1)?.event.type === "fix-asked") return;
      throw new UserError("nothing to go on from");
    }
    agent.send(goOnPrompt(stop), { asked: { kind: stop.kind, why: goOnWhy(stop) } });
  }
}
