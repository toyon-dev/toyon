// What the user attaches to a message. Images, files, and text long enough that the composer
// collapsed it into a chip, are written once under ~/.toyon/attachments/<worktreeId>/ and
// referenced from then on (the transcript holds the ref, the shell fetches
// /attachments/<worktreeId>/<file>), so the JSONL stays small and a resumed session still shows
// what was sent. An image is <n>.<ext> and a paste <n>.txt; a file is <n>-<name>, so the agent
// that is sent to read it sees its real extension. Each kind is numbered on its own, and the
// shapes keep the same number apart. A picked element is a few hundred bytes with nothing to
// fetch, so its ref is the whole of it.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttachmentInput,
  AttachmentRef,
  FileInput,
  FileRef,
  ImageInput,
  ImageRef,
  PasteInput,
  PasteRef,
  PickRef,
  ToolImage,
} from "@toyon/shared";
import { attachmentInputSchema, FILE_INLINE_CHARS, IMAGE_MIME_TYPES, pasteSummary } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { IMAGE_EXT as EXT, type UploadStore } from "./uploads.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** how much of a file's own name its stored copy keeps */
const NAME_MAX = 80;
/** a message's image or paste is numbered and a picture a tool returned is named by its bytes
 * (toolImage), which keeps the two apart in one directory */
const DRAWN = /^(?:\d{1,6}|[0-9a-f]{16})\.(png|jpg|gif|webp|txt)$/;
/** a message's file: its number, then its own name reduced to what is safe in a path and a URL */
const NAMED = new RegExp(`^\\d{1,6}-[A-Za-z0-9._-]{1,${NAME_MAX}}$`);
const isFile = (file: string): boolean => DRAWN.test(file) || NAMED.test(file);
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** the image type a stored name is served as, or null for everything that goes out as plain
 * text: a paste, and every file, whatever its own name ends in */
export function drawnType(file: string): string | null {
  return MIME[DRAWN.exec(file)?.[1] ?? ""] ?? null;
}

/** a file's own name as its stored copy carries it: the characters a path and a URL take as they
 * are, and the extension kept when the name is cut */
export function storedName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "file";
  if (safe.length <= NAME_MAX) return safe;
  const dot = safe.lastIndexOf(".");
  const ext = dot > 0 && safe.length - dot <= 16 ? safe.slice(dot) : "";
  return safe.slice(0, NAME_MAX - ext.length) + ext;
}

/** the bytes behind an image block a tool returned, and the ref the transcript keeps for it. Null
 * for a format the shell would not draw or an empty block. The name is a prefix of the bytes'
 * hash: long enough that two pictures never share it, and the same picture read twice (the agent
 * looks at its screenshot again after a re-render) is one file. */
export function toolImage(data: string, mimeType: string): { ref: ToolImage; bytes: Buffer } | null {
  const ext = (EXT as Record<string, string | undefined>)[mimeType];
  if (!ext) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) return null;
  const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
  return { ref: { file, mimeType, bytes: bytes.length }, bytes };
}

/** whether a name is one `write` would have given a file: the shape a URL segment must have
 * before it is joined onto any attachments directory, a live worktree's or an archive's */
export const isAttachmentFile = (file: string): boolean => isFile(file);

/** where one worktree's attachments live; removed with its transcript */
export function attachmentsDirFor(attachmentsDir: string, worktreeId: string): string {
  return join(attachmentsDir, worktreeId);
}

/** an attachment once written: its kind, the ref the transcript keeps, and what the prompt needs
 * that the ref only points at (an image's bytes, a paste's text, where an image or a file is, and
 * a short file's text) */
export type Stored =
  | { kind: "image"; ref: ImageRef; bytes: Buffer; path: string }
  | { kind: "paste"; ref: PasteRef; text: string }
  | { kind: "file"; ref: FileRef; path: string; text?: string }
  | { kind: "pick"; ref: PickRef };

const GONE = "the upload is gone; attach it again";

/** A stored file's text when it is short enough to go in the prompt, else null. The bytes are
 * counted first, since a character is never more than its bytes, and decoded strictly: that the
 * file reads as text is the sender's word. */
async function shortText(path: string, bytes: number): Promise<string | null> {
  // UTF-8 spends at most four bytes a character
  if (bytes > FILE_INLINE_CHARS * 4) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    return text.length <= FILE_INLINE_CHARS ? text : null;
  } catch {
    // not text after all: the path alone
    return null;
  }
}

export class AttachmentStore {
  /** the writes still in flight, by path: a tool-end names its picture before the bytes have
   * landed, and the shell's fetch can arrive in between */
  private pending = new Map<string, Promise<void>>();

  constructor(
    readonly dir: string,
    /** where an image's or a file's bytes wait from the moment it is attached */
    readonly uploads: UploadStore,
  ) {}

  /** a picture a tool returned, already named by `toolImage`; the same file written again is left
   * as it is, since the name is the bytes */
  async putToolImage(worktreeId: string, file: string, bytes: Buffer): Promise<void> {
    if (!ID.test(worktreeId) || !DRAWN.test(file)) throw new UserError("bad tool image");
    const path = join(attachmentsDirFor(this.dir, worktreeId), file);
    if (this.pending.has(path) || (await Bun.file(path).exists())) return;
    await this.write(worktreeId, file, (path) => writeFile(path, bytes));
  }

  /** settles once no write to this file is in flight; at once when none is */
  whenWritten(worktreeId: string, file: string): Promise<void> {
    return this.pending.get(join(attachmentsDirFor(this.dir, worktreeId), file)) ?? Promise.resolve();
  }

  /** write one attachment as number `n` of its kind. An image or a file is copied out of its
   * upload, which the caller lets go of afterwards. */
  async put(worktreeId: string, n: number, input: AttachmentInput): Promise<Stored> {
    if (!ID.test(worktreeId)) throw new UserError("bad worktree id");
    switch (input.kind) {
      case "image":
        return this.putImage(worktreeId, n, input);
      case "paste":
        return this.putText(worktreeId, n, input);
      case "file":
        return this.putFile(worktreeId, n, input);
      case "pick":
        return { kind: "pick", ref: { ...input, n } };
    }
  }

  private async putImage(worktreeId: string, n: number, img: ImageInput): Promise<Stored> {
    const from = this.uploads.path(img.upload);
    // an upload taken as a file is not one: the image caps and formats were never checked on it
    if (!from || this.uploads.imageType(img.upload) !== img.mimeType) throw new UserError(`${img.name}: ${GONE}`);
    const bytes = await readFile(from);
    const file = `${n}.${EXT[img.mimeType]}`;
    const path = await this.write(worktreeId, file, (to) => writeFile(to, bytes));
    return {
      kind: "image",
      bytes,
      path,
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

  private async putFile(worktreeId: string, n: number, input: FileInput): Promise<Stored> {
    const from = this.uploads.path(input.upload);
    if (!from) throw new UserError(`${input.name}: ${GONE}`);
    const file = `${n}-${storedName(input.name)}`;
    const path = await this.write(worktreeId, file, (to) => copyFile(from, to));
    const bytes = (await stat(path)).size;
    const text = input.text ? await shortText(path, bytes) : null;
    return {
      kind: "file",
      path,
      ...(text === null ? {} : { text }),
      ref: { kind: "file", n, name: input.name, bytes, text: input.text, file },
    };
  }

  private async putText(worktreeId: string, n: number, { text, name, source }: PasteInput): Promise<Stored> {
    if (text.length === 0) throw new UserError("empty paste");
    const file = `${n}.txt`;
    await this.write(worktreeId, file, (to) => writeFile(to, text));
    return {
      kind: "paste",
      text,
      ref: { kind: "paste", n, ...(name ? { name } : {}), ...(source ? { source } : {}), ...pasteSummary(text), file },
    };
  }

  /** What a sent message carried, as something a box can hold again. An image or a file is copied
   * back out of the store into a new upload, so the message it came from keeps its own; a paste
   * is read from its stored text. Null when the stored copy is gone or is not one a box takes.
   * Answered in the shape the wire's schema gives an attachment, so the list a tab sends back
   * for the box compares equal to the one it was handed. `archived` is where the copy lies when
   * the chat is an archived one, whose files moved out of this store with it. */
  async reattach(
    worktreeId: string,
    ref: AttachmentRef,
    archived?: (file: string) => string | null,
  ): Promise<AttachmentInput | null> {
    const again = await this.inputOf(worktreeId, ref, archived);
    const parsed = attachmentInputSchema.safeParse(again);
    return parsed.success ? parsed.data : null;
  }

  private async inputOf(
    worktreeId: string,
    ref: AttachmentRef,
    archived?: (file: string) => string | null,
  ): Promise<unknown> {
    if (ref.kind === "pick") {
      const { n: _n, ...pick } = ref;
      return pick;
    }
    let path: string | null = null;
    for (const at of [this.fileFor(worktreeId, ref.file), archived?.(ref.file) ?? null]) {
      if (at && (await Bun.file(at).exists())) {
        path = at;
        break;
      }
    }
    if (!path) return null;
    if (ref.kind === "paste") {
      const { name, source } = ref;
      return { kind: "paste", text: await readFile(path, "utf8"), name, source };
    }
    if (ref.kind === "file") {
      const upload = await this.uploads.adopt(path, null);
      return { kind: "file", upload, name: ref.name, bytes: ref.bytes, text: ref.text };
    }
    const mimeType = IMAGE_MIME_TYPES.find((m) => m === ref.mimeType);
    if (!mimeType) return null;
    const upload = await this.uploads.adopt(path, mimeType);
    const { name, bytes, width, height } = ref;
    return { kind: "image", upload, name, mimeType, bytes, width, height };
  }

  /** run `fill` on the file's path once its directory exists; answers the path */
  private async write(worktreeId: string, file: string, fill: (path: string) => Promise<void>): Promise<string> {
    const wtDir = attachmentsDirFor(this.dir, worktreeId);
    const path = join(wtDir, file);
    const done = mkdir(wtDir, { recursive: true })
      .then(() => fill(path))
      .finally(() => this.pending.delete(path));
    this.pending.set(path, done);
    await done;
    return path;
  }

  /** the path behind a shell request, or null when the segments are not ones we would have made
   * (the http layer passes URL parts straight through; the shapes are strict so no traversal
   * is possible) */
  fileFor(worktreeId: string, file: string): string | null {
    if (!ID.test(worktreeId) || !isFile(file)) return null;
    return join(attachmentsDirFor(this.dir, worktreeId), file);
  }
}
