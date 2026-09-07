// What the user attaches to a message: images, and text long enough that the composer collapsed
// it into a chip. Both are written once under ~/.toyon/attachments/<worktreeId>/<n>.<ext> and
// referenced from then on (the transcript holds an ImageRef or a PasteRef, the shell fetches
// /attachments/<worktreeId>/<file>), so the JSONL stays small and a resumed session still shows
// what was sent. Images and pastes are numbered separately; the extension keeps them apart.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageInput, ImageRef, PasteRef } from "@toyon/shared";
import { pasteSummary } from "@toyon/shared";
import { UserError } from "../core/errors.ts";

const EXT: Record<ImageInput["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^\d{1,6}\.(png|jpg|gif|webp|txt)$/;

/** where one worktree's attachments live; removed with its transcript */
export function attachmentsDirFor(attachmentsDir: string, worktreeId: string): string {
  return join(attachmentsDir, worktreeId);
}

export interface StoredImage {
  ref: ImageRef;
  /** the decoded bytes, for the prompt that carries this image */
  bytes: Buffer;
}

export interface StoredPaste {
  ref: PasteRef;
  /** the text, for the prompt that carries this paste */
  text: string;
}

export class AttachmentStore {
  constructor(readonly dir: string) {}

  async putImage(worktreeId: string, n: number, img: ImageInput): Promise<StoredImage> {
    if (!ID.test(worktreeId)) throw new UserError("bad worktree id");
    const bytes = Buffer.from(img.data, "base64");
    if (bytes.length === 0) throw new UserError(`${img.name}: empty image`);
    const file = `${n}.${EXT[img.mimeType]}`;
    const wtDir = attachmentsDirFor(this.dir, worktreeId);
    await mkdir(wtDir, { recursive: true });
    await writeFile(join(wtDir, file), bytes);
    return {
      bytes,
      ref: {
        n,
        name: img.name,
        mimeType: img.mimeType,
        bytes: bytes.length,
        width: img.width,
        height: img.height,
        file,
      },
    };
  }

  async putText(worktreeId: string, n: number, text: string, name?: string): Promise<StoredPaste> {
    if (!ID.test(worktreeId)) throw new UserError("bad worktree id");
    if (text.length === 0) throw new UserError("empty paste");
    const file = `${n}.txt`;
    const wtDir = attachmentsDirFor(this.dir, worktreeId);
    await mkdir(wtDir, { recursive: true });
    await writeFile(join(wtDir, file), text, "utf8");
    return { text, ref: { n, ...(name ? { name } : {}), ...pasteSummary(text), file } };
  }

  /** the path behind a shell request, or null when the segments are not ones we would have made
   * (the http layer passes URL parts straight through; the shapes are strict so no traversal
   * is possible) */
  fileFor(worktreeId: string, file: string): string | null {
    if (!ID.test(worktreeId) || !FILE.test(file)) return null;
    return join(attachmentsDirFor(this.dir, worktreeId), file);
  }
}
