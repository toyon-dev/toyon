// The one way a failure reaches the agent as work. Whoever meets a failure the agent can fix (a
// landing op, the check after a turn, the boot pane) names it as a FixReason; this sends the
// message that fixes it as Toyon's own, so the transcript shows what failed where a bubble nobody
// typed would have stood.

import type { Asked } from "@toyon/shared";
import { isMain } from "@toyon/shared";
import { type FixReason, fixPrompt, fixWhy } from "../agent/prompt.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import type { Hub } from "../core/hub.ts";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

export interface FixServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor">;
}

/** why the last message on a transcript was sent, when it was Toyon's own */
function lastAsked(entries: readonly TranscriptEntry[]): Asked | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "user-message") return e.asked;
  }
  return undefined;
}

export class FixService {
  constructor(private d: FixServiceDeps) {
    d.hub.on("checkFailed", (id, command) => {
      this.ask(id, { kind: "check", command });
    });
  }

  /** Send the worktree's agent the message that fixes `reason`. It is not the person's send, and
   * the rail does not move for it. False when nothing was sent: nothing runs on main, there is no
   * agent here, or a check failed again straight after the turn sent to fix it, since that turn
   * ends in the same check and an agent that cannot make it pass would go round for good. The
   * transcript is the count: the next check ask waits for a message that is not one. */
  ask(worktreeId: string, reason: FixReason): boolean {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || isMain(wt)) return false;
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) return false;
    if (reason.kind === "check" && lastAsked(agent.transcript())?.kind === "check") return false;
    agent.send(fixPrompt(reason), { asked: { kind: reason.kind, why: fixWhy(reason) } });
    return true;
  }
}
