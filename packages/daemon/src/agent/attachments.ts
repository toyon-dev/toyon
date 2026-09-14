// What the user attaches to a message. Images, and text long enough that the composer collapsed
// it into a chip, are written once under ~/.toyon/attachments/<worktreeId>/<n>.<ext> and
// referenced from then on (the transcript holds the ref, the shell fetches
// /attachments/<worktreeId>/<file>), so the JSONL stays small and a resumed session still shows
// what was sent. Each kind is numbered on its own; the extension keeps an image and a paste with the
// same number apart. A picked element is a few hundred bytes with nothing to fetch, so its ref is
// the whole of it.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentInput, ImageInput, ImageRef, PasteInput, PasteRef, PickRef } from "@toyon/shared";
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

/** whether a name is one `write` would have given a file: the shape a URL segment must have
 * before it is joined onto any attachments directory, a live worktree's or an archive's */
export const isAttachmentFile = (file: string): boolean => FILE.test(file);

/** where one worktree's attachments live; removed with its transcript */
export function attachmentsDirFor(attachmentsDir: string, worktreeId: string): string {
  return join(attachmentsDir, worktreeId);
}

/** an attachment once written: its kind, the ref the transcript keeps, and what the prompt needs
 * that the ref only points at (an image's decoded bytes, a paste's text) */
export type Stored =
  | { kind: "image"; ref: ImageRef; bytes: Buffer }
  | { kind: "paste"; ref: PasteRef; text: string }
  | { kind: "pick"; ref: PickRef };

export class AttachmentStore {
  constructor(readonly dir: string) {}

  /** write one attachment as number `n` of its kind */
  async put(worktreeId: string, n: number, input: AttachmentInput): Promise<Stored> {
    if (!ID.test(worktreeId)) throw new UserError("bad worktree id");
    switch (input.kind) {
      case "image":
        return this.putImage(worktreeId, n, input);
      case "paste":
        return this.putText(worktreeId, n, input);
      case "pick":
        return { kind: "pick", ref: { ...input, n } };
    }
  }

  private async putImage(worktreeId: string, n: number, img: ImageInput): Promise<Stored> {
    const bytes = Buffer.from(img.data, "base64");
    if (bytes.length === 0) throw new UserError(`${img.name}: empty image`);
    const file = `${n}.${EXT[img.mimeType]}`;
    await this.write(worktreeId, file, bytes);
    return {
      kind: "image",
      bytes,
      ref: {
        kind: "image",
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

  private async putText(worktreeId: string, n: number, { text, name, source }: PasteInput): Promise<Stored> {
    if (text.length === 0) throw new UserError("empty paste");
    const file = `${n}.txt`;
    await this.write(worktreeId, file, text);
    return {
      kind: "paste",
      text,
      ref: { kind: "paste", n, ...(name ? { name } : {}), ...(source ? { source } : {}), ...pasteSummary(text), file },
    };
  }

  private async write(worktreeId: string, file: string, data: Buffer | string) {
    const wtDir = attachmentsDirFor(this.dir, worktreeId);
    await mkdir(wtDir, { recursive: true });
    await writeFile(join(wtDir, file), data);
  }

  /** the path behind a shell request, or null when the segments are not ones we would have made
   * (the http layer passes URL parts straight through; the shapes are strict so no traversal
   * is possible) */
  fileFor(worktreeId: string, file: string): string | null {
    if (!ID.test(worktreeId) || !FILE.test(file)) return null;
    return join(attachmentsDirFor(this.dir, worktreeId), file);
  }
}
