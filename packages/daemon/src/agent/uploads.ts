// Bytes between the moment they are attached and the turn that records them. An image or a file is
// uploaded when its chip appears, so a message names it by id and the chat frame stays small, and
// a draft's chips are still there after a reload. An upload lives while something names it: a
// composer box's pending list, or a message that has arrived and not been recorded yet (a queued
// one records later, and variants send one upload to several worktrees). One that a box lets go of
// with no message holding it is deleted on the spot: a box is only emptied by a chip taken off, or
// by a send, which holds the uploads before the box gives them up.

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AttachmentInput,
  FILE_MAX_CHARS,
  fmtBytes,
  IMAGE_MAX_BYTES,
  IMAGE_MIME_TYPES,
  type ImageMimeType,
  UPLOAD_MAX_BYTES,
  type Uploaded,
} from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";

export const IMAGE_EXT: Record<ImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MIME_OF_EXT = new Map<string, ImageMimeType>(
  IMAGE_MIME_TYPES.map((mime): [string, ImageMimeType] => [IMAGE_EXT[mime], mime]),
);
/** what a file that is not one of the image types is stored under: its own extension would be the
 * browser's or the client's word for what it is */
const OTHER_EXT = "bin";
const NAME = /^([A-Za-z0-9_-]{1,64})\.(png|jpg|gif|webp|bin)$/;
/** How long an upload no box has named yet is kept. Long enough for a list queued behind a socket
 * that dropped to arrive once it is back; a chip whose upload went anyway is refused at send, in
 * words that say to attach it again. */
const UNNAMED_MS = 10 * 60_000;

/** said when a message names an upload that is no longer on disk */
export const GONE = "an attachment is no longer on this machine; attach it again";

export type UploadKind = "image" | "file";
export const isUploadKind = (kind: string | null): kind is UploadKind => kind === "image" || kind === "file";

/** the upload ids a list of attachments names */
export function uploadIds(items: readonly AttachmentInput[] | undefined): string[] {
  return (items ?? []).flatMap((a) => (a.kind === "image" || a.kind === "file" ? [a.upload] : []));
}

export class UploadStore {
  /** every upload on disk, by id, as the file it is under */
  private files = new Map<string, string>();
  /** messages that arrived naming an upload and have not recorded it yet, counted */
  private holds = new Map<string, number>();
  /** what the composer boxes' pending lists name, as last told */
  private named = new Set<string>();

  constructor(
    readonly dir: string,
    /** how long an upload waits for a box's list to name it */
    private unnamedMs = UNNAMED_MS,
  ) {
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) {
      const id = NAME.exec(file)?.[1];
      if (id) this.files.set(id, file);
    }
  }

  /** Write a request's body as a new upload. The caps are checked as the bytes arrive, since a
   * content-length is the client's claim; what is refused leaves nothing behind. */
  async put(
    kind: UploadKind,
    mime: string,
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null,
  ): Promise<Uploaded> {
    const image = (IMAGE_EXT as Record<string, string | undefined>)[mime];
    if (kind === "image" && !image) throw new UserError("not an image format the models accept");
    const cap = kind === "image" ? IMAGE_MAX_BYTES : UPLOAD_MAX_BYTES;
    const upload = randomBytes(12).toString("base64url");
    const file = `${upload}.${kind === "image" ? image : OTHER_EXT}`;
    const path = join(this.dir, file);
    const writer = Bun.file(path).writer();
    // decoded only as far as a chip would show: past that the answer changes nothing
    let decoder: TextDecoder | null = kind === "file" ? new TextDecoder("utf-8", { fatal: true }) : null;
    let bytes = 0;
    try {
      for await (const chunk of body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > cap) throw new UserError(`larger than ${fmtBytes(cap)}`);
        writer.write(chunk);
        // a full buffer is flushed before the next chunk is read, so memory holds one buffer
        await writer.flush();
        if (decoder && (bytes > FILE_MAX_CHARS || !decodes(decoder, chunk))) decoder = null;
      }
      if (bytes === 0) throw new UserError("empty file");
      await writer.end();
    } catch (e) {
      await Promise.resolve(writer.end()).catch(() => {
        // the write already failed; the removal below is what matters
      });
      rmSync(path, { force: true });
      throw e;
    }
    this.files.set(upload, file);
    this.expireUnnamed(upload);
    return { upload, bytes, text: decoder !== null };
  }

  /** A stored copy taken in as a new upload: what a sent message carried, on its way back into a
   * box. `image` is the type it is drawn as, or null for a file. Answers the new id. */
  async adopt(from: string, image: ImageMimeType | null): Promise<string> {
    const upload = randomBytes(12).toString("base64url");
    const file = `${upload}.${image ? IMAGE_EXT[image] : OTHER_EXT}`;
    await copyFile(from, join(this.dir, file));
    this.files.set(upload, file);
    this.expireUnnamed(upload);
    return upload;
  }

  /** Start a new upload's wait: gone when it ends unless something names or holds it by then. A
   * tab closed as its bytes landed leaves one nothing will ever name, and the daemon can run for
   * weeks before a boot sweep finds it. One a message holds when the wait ends goes when that
   * message lets go. */
  private expireUnnamed(id: string): void {
    const timer = setTimeout(() => {
      if (!this.named.has(id) && !this.holds.has(id)) this.remove(id);
    }, this.unnamedMs);
    timer.unref?.();
  }

  /** where an upload's bytes are, or null when there is no such upload */
  path(id: string): string | null {
    const file = this.files.get(id);
    return file ? join(this.dir, file) : null;
  }

  /** the image type an upload was taken as, or null for a file */
  imageType(id: string): ImageMimeType | null {
    const file = this.files.get(id);
    return (file && MIME_OF_EXT.get(file.slice(file.lastIndexOf(".") + 1))) || null;
  }

  /** whether an upload's bytes are still here */
  has(id: string): boolean {
    return this.files.has(id);
  }

  /** A message naming these uploads has arrived: they stay until `release`, whatever the boxes
   * say. All or none, and a `UserError` when one is gone, so the message is refused whole. */
  hold(ids: readonly string[]): void {
    if (ids.some((id) => !this.files.has(id))) throw new UserError(GONE);
    for (const id of ids) this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
  }

  /** The other half of `hold`: the message was recorded, or will never be, or is back in a box
   * that names its uploads again. */
  release(ids: readonly string[]): void {
    for (const id of ids) {
      const left = (this.holds.get(id) ?? 0) - 1;
      if (left > 0) {
        this.holds.set(id, left);
        continue;
      }
      this.holds.delete(id);
      if (!this.named.has(id)) this.remove(id);
    }
  }

  /** The boxes' lists changed, and these are the uploads they name now. One a list named before and
   * none does now goes, unless a message holds it. An upload no list has named yet is still in its
   * wait. */
  keep(named: Iterable<string>): void {
    const before = this.named;
    this.named = new Set(named);
    for (const id of before) if (!this.named.has(id) && !this.holds.has(id)) this.remove(id);
  }

  /** At boot: nothing is held (a queue does not survive a restart), so whatever no list names is
   * left over from a tab that closed mid-attach or a message that never recorded. */
  sweep(named: Iterable<string>): void {
    this.named = new Set(named);
    for (const id of [...this.files.keys()]) if (!this.named.has(id)) this.remove(id);
  }

  private remove(id: string): void {
    const file = this.files.get(id);
    if (!file) return;
    this.files.delete(id);
    try {
      rmSync(join(this.dir, file), { force: true });
    } catch (e) {
      log.warn("uploads", `could not delete ${file}`, e);
    }
  }
}

/** whether a chunk continues valid UTF-8 text. A NUL is valid UTF-8 and never text. */
function decodes(decoder: TextDecoder, chunk: Uint8Array): boolean {
  try {
    decoder.decode(chunk, { stream: true });
    return !chunk.includes(0);
  } catch {
    // not UTF-8: the answer the caller asked for
    return false;
  }
}
