// The unsent text in every composer box, by box id: a worktree's id (which an archive keeps), or a
// repo's new-worktree draft. The daemon holds it so a draft follows the person to another tab or
// device and outlives an archive, and so a worktree with words waiting in its box is not archived
// out from under them. Its own file rather than state.json: that one is rewritten whole on every
// save, and this changes as someone types.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";

export interface DraftDeps {
  file: string;
  hub: Hub;
  /** how long a burst of writes waits before it reaches the disk */
  saveDelayMs?: number;
}

const SAVE_DELAY_MS = 1_000;

export class DraftStore {
  private drafts: Record<string, string> = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private d: DraftDeps) {
    if (!existsSync(d.file)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(d.file, "utf8"));
      if (!raw || typeof raw !== "object") return;
      for (const [id, text] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof text === "string" && text) this.drafts[id] = text;
      }
    } catch (e) {
      // the cost of a bad file is empty boxes, which is where a first run starts anyway
      log.warn("drafts", `skipped an unreadable ${d.file}`, e);
    }
  }

  /** every box with something in it, for hello */
  all(): Record<string, string> {
    return { ...this.drafts };
  }

  has(boxId: string): boolean {
    return !!this.drafts[boxId]?.trim();
  }

  /** what a box holds, or nothing */
  text(boxId: string): string {
    return this.drafts[boxId] ?? "";
  }

  /** a box's text as one tab has it now; the other tabs are told, and the tab that wrote it knows
   * itself by `clientId` */
  set(boxId: string, text: string, clientId?: string): void {
    if ((this.drafts[boxId] ?? "") === text) return;
    if (text) this.drafts[boxId] = text;
    else delete this.drafts[boxId];
    this.scheduleSave();
    this.d.hub.emit("draftChanged", boxId, text, clientId);
  }

  /** a box whose worktree went for good: a discarded one, or an archive deleted */
  drop(boxId: string): void {
    this.set(boxId, "");
  }

  /** Boxes nothing names any more, dropped once at boot: a worktree deleted while the daemon was
   * down, or a project forgotten. Silent, since no tab is connected to be told. */
  prune(known: (boxId: string) => boolean): void {
    let changed = false;
    for (const id of Object.keys(this.drafts)) {
      if (known(id)) continue;
      delete this.drafts[id];
      changed = true;
    }
    if (changed) this.scheduleSave();
  }

  /** write what is waiting, now: the daemon is going down */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.write();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, this.d.saveDelayMs ?? SAVE_DELAY_MS);
    // a write still waiting must not hold a test run, or a daemon that is otherwise done, open
    this.saveTimer.unref?.();
  }

  /** atomic, like state.json: a crash mid-write must not leave half a file */
  private write(): void {
    const tmp = `${this.d.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.drafts));
      renameSync(tmp, this.d.file);
    } catch (e) {
      // a timer has no caller to hand a failed write to; the next keystroke tries again
      log.error("drafts", "could not write the drafts", e);
    }
  }
}
