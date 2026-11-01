// A picture the agent names in its prose: `![caption](/path/on/this/machine.png)`. The page cannot
// read a path, so the daemon copies the file into the worktree's attachment store, the way a
// picture a tool returned is kept, and tells the chat where the copy is by the path the prose
// wrote. The copy outlives the original (a render under /tmp) and draws again after a reload.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { IMAGE_MAX_BYTES, type ReplyPicture } from "@toyon/shared";
import { type AttachmentStore, toolImageBytes } from "./attachments.ts";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** a whole markdown image: a caption, then a target with no space or paren in it, as marked reads
 * one; an optional quoted title after the target */
const IMAGE = /!\[[^\]\n]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
/** how many pictures one reply is copied for: a walkthrough is a handful, and a reply naming a
 * hundred is a listing, not something to look at */
export const PICTURES_MAX = 24;

/** the targets of every whole markdown image in `text`, as written, that could be a file on this
 * machine: an absolute path, a `file://` URL, or a path relative to the worktree. A web image is
 * the browser's to fetch. One inside a fenced block is markdown being shown, not a picture. */
export function pictureLinks(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.matchAll(IMAGE)) {
      const href = m[1] ?? "";
      if (/^(https?|data):/i.test(href)) continue;
      if (!out.includes(href)) out.push(href);
    }
  }
  return out;
}

/** where a target names a file: `file://` stripped, a relative one read from the worktree */
export function picturePath(href: string, cwd: string): string {
  const path = href.match(/^file:\/\/(?:localhost)?(\/.*)$/i)?.[1] ?? href;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // a percent that is not an escape: the path as written
  }
  return resolve(cwd, decoded);
}

/** The file behind a picture target, copied into the worktree's store, and the event the chat
 * draws it from. Null when there is nothing to draw: no such file, one too large for the chat, or
 * not an image type the chat shows. The name is the bytes' hash, so a picture named twice (a
 * re-render the agent looks at again) is one file. */
export async function adoptPicture(
  store: AttachmentStore,
  worktreeId: string,
  cwd: string,
  href: string,
): Promise<ReplyPicture | null> {
  const path = picturePath(href, cwd);
  const mimeType = MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  if (!mimeType) return null;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > IMAGE_MAX_BYTES) return null;
  const image = toolImageBytes(await readFile(path), mimeType);
  if (!image) return null;
  await store.putToolImage(worktreeId, image.ref.file, image.bytes);
  return { path: href, ...image.ref };
}
