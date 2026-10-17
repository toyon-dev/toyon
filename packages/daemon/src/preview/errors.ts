// What the preview's page threw, per worktree, as the person's browser reported it through the
// bridge and the shell. Held here rather than in the shell: the block behind every message is
// composed here, and that block is how the agent hears it. What is held is what the page has
// thrown since it last loaded; a load wipes it, so a page that comes back clean after a fix has
// nothing to say. Nothing goes on the transcript and nothing goes to the agent unasked: the dev
// server hot-swaps every file the agent writes, a half-written edit throws as a matter of course,
// and a row for each would fill the chat with the turn's rough drafts.

import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";

export interface PageErrorDeps {
  hub: Hub;
  /** whether the worktree is on the record: a tab holding a row that has since gone, or any
   * client naming an id, holds nothing here */
  known: (worktreeId: string) => boolean;
  now?: () => number;
}

/** how many of a page's errors are kept: the first ones say what broke, the rest repeat it */
const KEPT = 5;
/** two tabs showing one preview forward the same throw twice; closer than this, it is one */
const TWICE_MS = 1000;

export class PageErrorService {
  private held = new Map<string, Array<{ message: string; ts: number }>>();

  constructor(private d: PageErrorDeps) {
    // a worktree that went takes what its page threw with it
    d.hub.on("worktreesChanged", () => {
      for (const id of this.held.keys()) if (!d.known(id)) this.held.delete(id);
    });
  }

  /** the page threw, as the bridge worded it */
  report(worktreeId: string, message: string): void {
    if (!this.d.known(worktreeId)) {
      log.debug("pages", `an error from unknown worktree ${worktreeId} was dropped`);
      return;
    }
    let h = this.held.get(worktreeId);
    if (!h) {
      h = [];
      this.held.set(worktreeId, h);
    }
    const now = this.d.now?.() ?? Date.now();
    const last = h.at(-1);
    if (last && last.message === message && now - last.ts < TWICE_MS) return;
    h.push({ message, ts: now });
    if (h.length > KEPT) h.splice(0, h.length - KEPT);
  }

  /** the page started over, or hot-swapped what it runs: what it threw before is gone with it,
   * and a throw that is still there comes again on the fresh render */
  loaded(worktreeId: string): void {
    this.held.delete(worktreeId);
  }

  /** what the page has thrown since it last loaded, oldest first */
  recent(worktreeId: string): string[] {
    return this.held.get(worktreeId)?.map((e) => e.message) ?? [];
  }

  /** the paragraph behind a message that says what the page has thrown, or nothing */
  ambient(worktreeId: string): string | undefined {
    const errors = this.recent(worktreeId);
    if (errors.length === 0) return undefined;
    return `The preview has thrown since it last loaded:\n${errors.map((e) => `- ${e}`).join("\n")}`;
  }
}
