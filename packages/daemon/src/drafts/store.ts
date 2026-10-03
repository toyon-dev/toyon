// What is unsent in every composer box, by box id: a worktree's id (which an archive keeps), or a
// repo's new-worktree draft. The text, and beside it what is attached. The daemon holds both so a
// draft follows the person to another tab or device and outlives an archive, and so a worktree
// with something waiting in its box is not archived out from under them. Files of their own rather
// than state.json: that one is rewritten whole on every save, and this changes as someone types.
// The attachment lists have a file of their own again, so the text's file keeps its shape.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type AttachmentInput, attachmentInputSchema } from "@toyon/shared";
import { uploadIds } from "../agent/uploads.ts";
import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";

export interface DraftDeps {
  file: string;
  /** where the attachment lists are kept */
  attachmentsFile: string;
  hub: Hub;
  /** told which uploads the lists name whenever one changes, so one nothing names any more goes */
  uploads?: { keep(named: Iterable<string>): void };
  /** how long a burst of writes waits before it reaches the disk */
  saveDelayMs?: number;
}

const SAVE_DELAY_MS = 1_000;

/** what one composer box holds: its words and what is attached */
export interface Box {
  text: string;
  items: AttachmentInput[];
}

export class DraftStore {
  private drafts: Record<string, string> = {};
  private lists: Record<string, AttachmentInput[]> = {};
  /** which of the two files has changes waiting */
  private dirty = { text: false, lists: false };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private d: DraftDeps) {
    for (const [id, text] of readRecord(d.file)) {
      if (typeof text === "string" && text) this.drafts[id] = text;
    }
    for (const [id, list] of readRecord(d.attachmentsFile)) {
      // an item a newer or older daemon wrote in another shape is dropped alone
      const items = (Array.isArray(list) ? list : []).flatMap((item) => {
        const r = attachmentInputSchema.safeParse(item);
        return r.success ? [r.data] : [];
      });
      if (items.length) this.lists[id] = items;
    }
  }

  /** every box with text in it, for hello */
  all(): Record<string, string> {
    return { ...this.drafts };
  }

  /** every box with something attached, for hello */
  allAttachments(): Record<string, AttachmentInput[]> {
    return { ...this.lists };
  }

  /** written in: words, or something attached */
  has(boxId: string): boolean {
    return !!this.drafts[boxId]?.trim() || !!this.lists[boxId]?.length;
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
    this.scheduleSave("text");
    this.d.hub.emit("draftChanged", boxId, text, clientId);
  }

  /** what a box has attached, or nothing */
  attachments(boxId: string): AttachmentInput[] {
    return this.lists[boxId] ?? [];
  }

  /** a box's attachments as one tab has them now, told to the other tabs the way its text is */
  setAttachments(boxId: string, items: AttachmentInput[], clientId?: string): void {
    if (JSON.stringify(this.lists[boxId] ?? []) === JSON.stringify(items)) return;
    if (items.length) this.lists[boxId] = items;
    else delete this.lists[boxId];
    this.scheduleSave("lists");
    this.d.uploads?.keep(this.uploadIds());
    this.d.hub.emit("attachmentsChanged", boxId, items, clientId);
  }

  /** A message leaving its box: what the box held, and the box empty in every tab. `clientId` is
   * the tab that sent it, which has emptied its own. The caller holds the uploads first, so none
   * goes in the moment no list names it. */
  take(boxId: string, clientId?: string): Box {
    const was = { text: this.text(boxId), items: this.attachments(boxId) };
    this.set(boxId, "", clientId);
    this.setAttachments(boxId, [], clientId);
    return was;
  }

  /** A message back in the box it left: one no agent took, or one taken out of the queue or the
   * transcript to be changed. Words only into an empty box, since what has been typed there since
   * is newer; chips ahead of anything attached since. Its uploads are named again here, before
   * whoever held them lets go. */
  putBack(boxId: string, was: Box, clientId?: string): void {
    if (was.text && !this.text(boxId)) this.set(boxId, was.text, clientId);
    if (was.items.length) this.setAttachments(boxId, [...was.items, ...this.attachments(boxId)], clientId);
  }

  /** every upload some box's list names */
  uploadIds(): string[] {
    return Object.values(this.lists).flatMap((items) => uploadIds(items));
  }

  /** a box whose worktree went for good: a discarded one, or an archive deleted */
  drop(boxId: string): void {
    this.set(boxId, "");
    this.setAttachments(boxId, []);
  }

  /** Everything in one box goes to another, which is the row standing in for it now. Only into an
   * empty box unless `over`: what someone has already put there is theirs. The words and the chips
   * go as one, so the box that takes them holds that message and none of its own. Answers whether
   * it moved. */
  move(fromId: string, toId: string, over = false): boolean {
    const text = this.text(fromId);
    const items = this.attachments(fromId);
    if (!text && !items.length) return false;
    if (!over && (this.text(toId) || this.attachments(toId).length)) return false;
    this.set(toId, text);
    // named by the new box before the old one lets go, so no upload is unnamed in between
    this.setAttachments(toId, items);
    this.drop(fromId);
    return true;
  }

  /** Boxes nothing names any more, dropped once at boot: a worktree deleted while the daemon was
   * down, or a project forgotten. Silent, since no tab is connected to be told. */
  prune(known: (boxId: string) => boolean): void {
    for (const id of Object.keys(this.drafts)) {
      if (known(id)) continue;
      delete this.drafts[id];
      this.scheduleSave("text");
    }
    for (const id of Object.keys(this.lists)) {
      if (known(id)) continue;
      delete this.lists[id];
      this.scheduleSave("lists");
    }
  }

  /** write what is waiting, now: the daemon is going down */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.write();
  }

  private scheduleSave(which: "text" | "lists"): void {
    this.dirty[which] = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, this.d.saveDelayMs ?? SAVE_DELAY_MS);
    // a write still waiting must not hold a test run, or a daemon that is otherwise done, open
    this.saveTimer.unref?.();
  }

  private write(): void {
    if (this.dirty.text) writeAtomic(this.d.file, this.drafts);
    if (this.dirty.lists) writeAtomic(this.d.attachmentsFile, this.lists);
    this.dirty = { text: false, lists: false };
  }
}

function readRecord(file: string): Array<[string, unknown]> {
  if (!existsSync(file)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>) : [];
  } catch (e) {
    // the cost of a bad file is empty boxes, which is where a first run starts anyway
    log.warn("drafts", `skipped an unreadable ${file}`, e);
    return [];
  }
}

/** atomic, like state.json: a crash mid-write must not leave half a file */
function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch (e) {
    // a timer has no caller to hand a failed write to; the next change tries again
    log.error("drafts", `could not write ${file}`, e);
  }
}
