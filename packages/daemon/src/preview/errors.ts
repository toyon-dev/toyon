// What the preview's page threw, per worktree, as the person's browser reported it through the
// bridge and the shell. Held here rather than in the shell: the agent's turn ends in the daemon,
// the block behind every message is composed here, and a tool that asks what the page threw asks
// here. What is held is what the page has thrown since it last loaded; a load wipes it, so a page
// that comes back clean after a fix has nothing to say.
//
// An error that arrives after a turn's edits is also written onto the transcript as a row, from
// the turn's first write until the next message, since that is the one the agent caused and the
// person would otherwise be the first to meet: the page reloads after the turn, and the crash
// lands on it a second or two after the turn is over. Nothing goes to the agent from here; the box
// offers a press under the rows, and the press sends it as Toyon's own message (worktrees/fix.ts).

import type { AgentEvent } from "@toyon/shared";
import { isEditTool } from "@toyon/shared";
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
/** how many rows a turn's edits may put on the transcript: a loop that throws on every tick
 * would otherwise write the chat full */
const NOTED_MAX = 3;
/** two tabs showing one preview forward the same throw twice; closer than this, it is one */
const TWICE_MS = 1000;

interface Held {
  recent: Array<{ message: string; ts: number }>;
  /** the turn under way, or the one just over, wrote something: an error now is its doing */
  writes: boolean;
  /** what has been put on the transcript for those writes */
  noted: Set<string>;
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
      h = { recent: [], writes: false, noted: new Set() };
      this.held.set(worktreeId, h);
    }
    return h;
  }

  /** The window a row is written in: open from the turn's first call that could change the tree
   * (an edit, a command: the same reading the box and the press make of the rows), shut by the
   * next message, the person's or Toyon's own, since from there the agent hears what the page
   * threw anyway. */
  private heard(worktreeId: string, event: AgentEvent) {
    const h = this.of(worktreeId);
    if (event.type === "turn-start" || event.type === "user-message" || event.type === "fix-asked") {
      h.writes = false;
    } else if (
      (event.type === "tool-start" || (event.type === "tool-update" && event.kind)) &&
      isEditTool({ name: event.name ?? "", kind: event.kind }) &&
      !h.writes
    ) {
      h.writes = true;
      h.noted = new Set();
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
    if (!h.writes || h.noted.has(message) || h.noted.size >= NOTED_MAX) return;
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) return;
    h.noted.add(message);
    agent.note({ type: "page-error", message, ts: now });
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
