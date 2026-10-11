// What the preview's page threw, per worktree, as the person's browser reported it through the
// bridge and the shell. Held here rather than in the shell: the agent's turn ends in the daemon,
// the block behind every message is composed here, and a tool that asks what the page threw asks
// here. What is held is what the page has thrown since it last loaded; a load wipes it, so a page
// that comes back clean after a fix has nothing to say.
//
// Some of it is also written onto the transcript as a row, since the person would otherwise be
// the first to meet it. Not while a turn runs: the dev server hot-swaps every file the agent
// writes, a half-written edit throws as a matter of course, and the agent may well fix it two
// edits later; a row for each would fill the chat with the turn's rough drafts. So what the page
// throws during a turn is held, and what it still throws when the turn ends goes down as one row,
// which is the state the agent left the page in. From there, while the agent is idle, what the
// page throws as the person clicks about it is a row each, until the next message. Nothing goes
// to the agent from here; the box offers a press under the rows, and the press sends it as
// Toyon's own message (worktrees/fix.ts).

import type { AgentEvent } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

export interface PageErrorDeps {
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor">;
  /** whether the worktree is on the record: a tab holding a row that has since gone, or any
   * client naming an id, holds nothing here */
  known: (worktreeId: string) => boolean;
  now?: () => number;
}

/** how many of a page's errors are kept: the first ones say what broke, the rest repeat it */
const KEPT = 5;
/** how many rows may go on the transcript between one message and the next: a page that throws
 * on every click would otherwise write the chat full */
const ROWS_MAX = 3;
/** two tabs showing one preview forward the same throw twice; closer than this, it is one */
const TWICE_MS = 1000;

interface Held {
  recent: Array<{ message: string; ts: number }>;
  /** a turn is under way: what the page throws waits for its end */
  running: boolean;
  /** what has gone on the transcript since the last message, so a throw that stays is one row,
   * however many loads it comes back on, and how many rows that is */
  noted: Set<string>;
  rows: number;
}

export class PageErrorService {
  private held = new Map<string, Held>();

  constructor(private d: PageErrorDeps) {
    d.hub.on("agent", (worktreeId, _seq, event) => this.heard(worktreeId, event));
    // a worktree that went takes what its page threw with it
    d.hub.on("worktreesChanged", () => {
      for (const id of this.held.keys()) if (!d.known(id)) this.held.delete(id);
    });
  }

  private of(worktreeId: string): Held {
    let h = this.held.get(worktreeId);
    if (!h) {
      h = { recent: [], running: false, noted: new Set(), rows: 0 };
      this.held.set(worktreeId, h);
    }
    return h;
  }

  /** Where the turn stands. A message, the person's or Toyon's own, starts the count of rows
   * over: from there the agent hears what the page threw anyway. A turn that fails ends without
   * a `turn-end`, so the error is read as the end too. */
  private heard(worktreeId: string, event: AgentEvent) {
    const h = this.of(worktreeId);
    switch (event.type) {
      case "user-message":
      case "fix-asked":
        h.noted = new Set();
        h.rows = 0;
        break;
      case "turn-start":
        h.running = true;
        break;
      case "turn-end":
      case "agent-error":
      case "agent-auth-required":
        h.running = false;
        this.flush(worktreeId, h, event.ts);
        break;
    }
  }

  /** the page threw, as the bridge worded it */
  report(worktreeId: string, message: string): void {
    if (!this.d.known(worktreeId)) {
      log.debug("pages", `an error from unknown worktree ${worktreeId} was dropped`);
      return;
    }
    const h = this.of(worktreeId);
    const now = this.d.now?.() ?? Date.now();
    const last = h.recent.at(-1);
    if (last && last.message === message && now - last.ts < TWICE_MS) return;
    h.recent.push({ message, ts: now });
    if (h.recent.length > KEPT) h.recent.splice(0, h.recent.length - KEPT);
    if (!h.running) this.flush(worktreeId, h, now);
  }

  /** what the page has thrown that is not on the transcript yet goes down as one row */
  private flush(worktreeId: string, h: Held, ts: number) {
    const fresh = [...new Set(h.recent.map((e) => e.message))].filter((m) => !h.noted.has(m));
    if (fresh.length === 0 || h.rows >= ROWS_MAX) return;
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) return;
    for (const m of fresh) h.noted.add(m);
    h.rows++;
    agent.note({ type: "page-error", errors: fresh, ts });
  }

  /** the page started over, or hot-swapped what it runs: what it threw before is gone with it,
   * and a throw that is still there comes again on the fresh render */
  loaded(worktreeId: string): void {
    const h = this.held.get(worktreeId);
    if (h) h.recent = [];
  }

  /** what the page has thrown since it last loaded, oldest first */
  recent(worktreeId: string): string[] {
    return this.held.get(worktreeId)?.recent.map((e) => e.message) ?? [];
  }

  /** the paragraph behind a message that says what the page has thrown, or nothing */
  ambient(worktreeId: string): string | undefined {
    const errors = this.recent(worktreeId);
    if (errors.length === 0) return undefined;
    return `The preview has thrown since it last loaded:\n${errors.map((e) => `- ${e}`).join("\n")}`;
  }
}
