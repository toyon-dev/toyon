// A restart someone asked for. The daemon holds every agent session, so a chat mid-reply is waited
// out rather than cut off: the request stands, and the restart follows the last working chat
// settling. A chat stopped on a question is not waited on. It resumes after the restart, and
// waiting on a person could hold the restart forever.

import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { Hub } from "./hub.ts";
import type { StateStore } from "./state.ts";

export interface RestarterDeps {
  hub: Hub;
  state: Pick<StateStore, "worktrees">;
  runtime: Pick<RuntimeRegistry, "agentFor">;
  /** why this daemon may not replace itself, or null when it may */
  refusal: () => string | null;
  /** stop and start again; called at most once */
  go: () => void;
}

export class Restarter {
  private asked = false;
  private gone = false;
  /** the wait as last announced, so a status tick that changes nothing announces nothing */
  private announced: string | null = null;

  constructor(private d: RestarterDeps) {
    const settle = () => {
      if (this.asked) this.attempt();
    };
    d.hub.on("agentStatus", settle);
    // a working chat can also end by being removed
    d.hub.on("worktreesChanged", settle);
  }

  /** Ask for a restart. Answers a refusal, or null having restarted or queued behind a reply.
   * `now` goes without the wait: whoever asked has read which chats it cuts off. */
  request(opts: { now?: boolean } = {}): string | null {
    const refused = this.d.refusal();
    if (refused) return refused;
    this.asked = true;
    this.attempt(opts.now);
    return null;
  }

  /** the chats a requested restart waits on, empty once it is under way; null when nobody asked */
  waitingOn(): string[] | null {
    if (!this.asked) return null;
    return this.gone ? [] : this.working();
  }

  /** the chats replying right now, by title */
  working(): string[] {
    return this.d.state.worktrees
      .filter((w) => this.d.runtime.agentFor(w.id)?.status === "working")
      .map((w) => w.title);
  }

  private attempt(now = false): void {
    if (this.gone) return;
    if (now || this.working().length === 0) this.gone = true;
    // announced before going, so every tab hears the restart is under way before its socket drops
    const key = JSON.stringify(this.waitingOn());
    if (key !== this.announced) {
      this.announced = key;
      this.d.hub.emit("updateChanged");
    }
    if (this.gone) this.d.go();
  }
}
