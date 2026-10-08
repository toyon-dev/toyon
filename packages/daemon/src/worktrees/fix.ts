// The one place a failure is answered. Whoever meets one (a landing op, the check after a turn, a
// press on the boot pane or on a failed command's offer) names it as a Failure and reports it
// here; the table says what follows. An ask is Toyon's own message to the agent, so the
// transcript shows what failed where a bubble nobody typed would have stood. An offer is the same
// ask waiting for a press. The press that sends the agent on after a stop or an error is answered
// here too: not a failure to fix, but the same kind of message, Toyon's own and shown as its reason.

import type { Asked } from "@toyon/shared";
import { isMain } from "@toyon/shared";
import { unformatOutput } from "../agent/output.ts";
import {
  type FailedRun,
  type Failure,
  failedRun,
  failureContext,
  fixPrompt,
  fixWhy,
  goOnPrompt,
  goOnWhy,
  type Stop,
} from "../agent/prompt.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

export interface FixServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor">;
}

/** What follows a failure. `ask` sends the agent the turn that fixes it, unasked; `offer` sends
 * nothing until a person presses for it. `once`: not twice in a row, for an ask that nobody
 * pressed. That is the check's alone: the turn sent to fix it ends in the same check, and an
 * agent that cannot make it pass would go round for good. A hook or a conflict comes back only
 * through another press of commit, land or sync, so a cap there would drop the second refusal
 * with nobody told.
 *
 * A person's own command is offered and never sent: many fail on purpose. A dev server that is
 * down is offered by the boot pane's own button. */
export const RESPONSE: Record<Failure["kind"], { does: "ask" | "offer"; once?: true }> = {
  hook: { does: "ask" },
  conflict: { does: "ask" },
  check: { does: "ask", once: true },
  command: { does: "offer" },
  preview: { does: "offer" },
};

/** what the last message on a transcript was sent to fix, when it was Toyon's own */
function lastAsked(entries: readonly TranscriptEntry[]): Asked["kind"] | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "fix-asked") return e.kind;
    if (e.type === "user-message") return undefined;
  }
  return undefined;
}

/** the row was handed to the agent already */
function askedFor(entries: readonly TranscriptEntry[], toolId: string): boolean {
  return entries.some(({ event }) => event.type === "fix-asked" && event.toolId === toolId);
}

/** How the chat ends, when it ends on a turn that was stopped or that failed and nothing has been
 * said since: the same reading the box makes to offer the press, so a press on a stale page sends
 * nothing. The figures a turn leaves behind it are not words, so they are read past. Null once
 * anything else is the last thing, including the ask a press already sent. */
export function lastStop(entries: readonly TranscriptEntry[]): Stop | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "usage" || e.type === "session-info") continue;
    if (e.type === "turn-end" && e.stopReason === "interrupted") return { kind: "stopped" };
    if (e.type === "agent-error") return { kind: "failed", error: e.message };
    return null;
  }
  return null;
}

/** The failure a fixable row stands for, rebuilt from what the transcript holds: the command its
 * start named and the output its end kept. Null for a row that is not there or that the daemon
 * never marked: the mark is the daemon's own word, and a row's name is not. */
function failureOf(entries: readonly TranscriptEntry[], toolId: string): Failure | null {
  let command: string | undefined;
  for (const { event } of entries) {
    if (event.type === "tool-start" && event.toolId === toolId) {
      const input = event.input as { command?: unknown } | null;
      command = typeof input?.command === "string" ? input.command : undefined;
    } else if (event.type === "tool-end" && event.toolId === toolId) {
      if (!event.fixable || command === undefined) return null;
      const run: FailedRun = { toolId, command, text: unformatOutput(event.output ?? "") };
      if (event.fixable.kind === "hook") return { kind: "hook", hook: event.fixable.hook ?? "git", ...run };
      return { kind: event.fixable.kind, ...run };
    }
  }
  return null;
}

export class FixService {
  constructor(private d: FixServiceDeps) {
    d.hub.on("checkFailed", (id, run) => {
      this.report(id, { kind: "check", ...run });
    });
  }

  /** A failure met on a worktree, answered by the table. True when the agent was sent the
   * message that fixes it, which is not the person's send, and the rail does not move for it.
   * False when nothing was sent: the table offers this one and nobody pressed, nothing runs on
   * main, there is no agent here, the same failure was asked about straight before (`once`; the
   * transcript is the count, and the next ask waits for a message that is not one), or the row
   * was handed over already. `pressed` is a person asking for the fix: it sends what the table
   * only offers, and it is not held to `once`. */
  report(worktreeId: string, failure: Failure, opts: { pressed?: boolean } = {}): boolean {
    const response = RESPONSE[failure.kind];
    if (response.does === "offer" && !opts.pressed) return false;
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || isMain(wt)) return false;
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) return false;
    const entries = agent.transcript();
    if (response.once && !opts.pressed && lastAsked(entries) === failure.kind) return false;
    const toolId = failedRun(failure)?.toolId;
    if (toolId && askedFor(entries, toolId)) return false;
    const context = failureContext(failure);
    agent.send(fixPrompt(failure), {
      asked: { kind: failure.kind, why: fixWhy(failure), ...(toolId ? { toolId } : {}) },
      ...(context ? { context: [context] } : {}),
    });
    return true;
  }

  /** The press on a row's offer: the failure is read back off the transcript, never taken from
   * the client. A second press on a row already handed over is not an error and sends nothing. */
  press(worktreeId: string, toolId: string): void {
    this.d.state.requireWorktree(worktreeId);
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    const entries = agent.transcript();
    const failure = failureOf(entries, toolId);
    if (!failure) throw new UserError("nothing to fix on that row");
    if (askedFor(entries, toolId)) return;
    if (!this.report(worktreeId, failure, { pressed: true })) throw new UserError("nothing runs on main");
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
