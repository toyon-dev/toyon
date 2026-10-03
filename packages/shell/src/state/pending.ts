// An attachment waiting in a composer box, and its two crossings: out to the wire, and back in
// from the list the daemon keeps for the box (another tab's, or this one's after a reload).

import {
  type AttachmentInput,
  type FileInput,
  type ImageInput,
  type PasteInput,
  type PickInput,
  pasteSummary,
} from "@toyon/shared";

/** what an image or a file adds while it is on its way to the daemon: the chip is up at once, and
 * `upload` is empty until the bytes have landed */
interface Uploading {
  /** an object URL over the bytes this tab holds, for the thumbnail until the daemon serves it */
  local?: string;
  uploading?: boolean;
}

/** an attachment waiting in a composer box: what the wire takes, a local key, and what its chip
 * shows before the daemon has stored it */
export type PendingAttachment =
  | (ImageInput & { key: string } & Uploading)
  | (PasteInput & { key: string; chars: number; lines: number; preview: string })
  | (FileInput & { key: string } & Uploading)
  | (PickInput & { key: string });

/** still uploading: nothing the daemon can be told about yet, and nothing a message can carry */
export const isUploading = (a: PendingAttachment): boolean => "uploading" in a && a.uploading === true;

/** what the wire takes of a waiting attachment: the key and the chip's figures stay behind, since
 * the daemon derives its own */
export function toInput(a: PendingAttachment): AttachmentInput {
  switch (a.kind) {
    case "image":
    case "file": {
      const { key: _key, local: _local, uploading: _uploading, ...input } = a;
      return input;
    }
    case "paste": {
      const { key: _key, chars: _chars, lines: _lines, preview: _preview, ...input } = a;
      return input;
    }
    case "pick": {
      const { key: _key, ...input } = a;
      return input;
    }
  }
}

/** a box's list as the daemon is told it: what has settled, in order */
export const settledInputs = (list: readonly PendingAttachment[]): AttachmentInput[] =>
  list.filter((a) => !isUploading(a)).map(toInput);

let keySeq = 0;

/** A box's list as the daemon holds it, laid over what the box has. An item already waiting keeps
 * its chip (and its key, so nothing on screen is rebuilt); uploads still in flight here are this
 * tab's alone and stay at the end. */
export function fromInputs(items: readonly AttachmentInput[], had: readonly PendingAttachment[]): PendingAttachment[] {
  const known = new Map(had.filter((a) => !isUploading(a)).map((a) => [JSON.stringify(toInput(a)), a]));
  const out = items.map((item): PendingAttachment => {
    const raw = JSON.stringify(item);
    const same = known.get(raw);
    if (same) {
      // one chip per listed item, should the same thing be attached twice
      known.delete(raw);
      return same;
    }
    const key = `d${++keySeq}`;
    return item.kind === "paste" ? { ...item, key, ...pasteSummary(item.text) } : { ...item, key };
  });
  return [...out, ...had.filter(isUploading)];
}
