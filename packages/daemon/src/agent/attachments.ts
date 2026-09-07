// Images the user attaches to a message. The shell sends them base64 in the frame; they are
// written once under ~/.toyon/attachments/<worktreeId>/<n>.<ext> and referenced from then on
// (the transcript holds an ImageRef, the shell fetches /attachments/<worktreeId>/<file>), so the
// JSONL stays small and a resumed session still shows what was sent.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageInput, ImageRef } from "@toyon/shared";
import { UserError } from "../core/errors.ts";

const EXT: Record<ImageInput["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^\d{1,6}\.(png|jpg|gif|webp)$/;

/** where one worktree's images live; removed with its transcript */
export function attachmentsDirFor(attachmentsDir: string, worktreeId: string): string {
  return join(attachmentsDir, worktreeId);
}

export interface StoredImage {
  ref: ImageRef;
  /** the decoded bytes, for the prompt that carries this image */
  bytes: Buffer;
}

export class AttachmentStore {
  constructor(readonly dir: string) {}

  async put(worktreeId: string, n: number, img: ImageInput): Promise<StoredImage> {
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

  /** the path behind a shell request, or null when the segments are not ones we would have made
   * (the http layer passes URL parts straight through; the shapes are strict so no traversal
   * is possible) */
  fileFor(worktreeId: string, file: string): string | null {
    if (!ID.test(worktreeId) || !FILE.test(file)) return null;
    return join(attachmentsDirFor(this.dir, worktreeId), file);
  }
}
